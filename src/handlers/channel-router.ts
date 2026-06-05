/**
 * Sage v2 channel router.
 *
 * Listens for app_mention events scoped to channels configured in
 * src/config/channels.yaml (intake, alerts, or test roles). For each
 * mention, classifies the intent via Claude Haiku and routes to the
 * appropriate handler.
 *
 * Per PRD US-001:
 * - intake channels: all five intents (info_lookup, work_request,
 *   status_query, light_qc, unclear) are valid.
 * - alerts channels: only info_lookup and status_query are valid;
 *   work_request returns a redirect to the requester's division channel.
 * - test channels: same as intake but Sage operates in dev mode
 *   (downstream Monday writes / DM nudges suppressed by stories that
 *   own those side effects).
 *
 * If the channel is not in channels.yaml, the router replies once
 * with a "I'm not set up for this channel yet" message and returns.
 *
 * Real handlers for each intent are wired in subsequent stories
 * (US-006 quick-info, US-007 light-QC, US-009/010/011 work_request
 * modal flow, US-016 status_query). For now, stub responses are
 * posted so the routing infrastructure is testable end-to-end.
 */

import type { App } from '@slack/bolt';
import { roleForChannel, divisionForChannel, findChannelsByRole, type ChannelRole } from '../lib/division-lookup';
import { classifyChannelMention, type V2Intent } from '../lib/v2-classifier';
import { logRequestEvent } from '../lib/event-log';
import { getQuickInfoResponse } from './quick-info';
import { handleLightQC } from './light-qc';
import { postOpenModalButton } from './intake-modal';
import { getHelpMessage } from './intent';
import { handleVisibilityQuery } from './visibility-query';
import { handlePostSubmissionFollowUp } from './post-submission';
import { config } from '../lib/config';
import { createFeedbackItem } from '../lib/monday';

// Threads where a user triggered the bug-report flow and we're waiting
// for their description. Key: threadTs, value: {userId, channelId, ts}.
// Exported so messages.ts can intercept plain (non-@mention) thread replies.
export const pendingChannelBugReports = new Map<string, { userId: string; channelId: string; ts: number }>();
export const pendingChannelFeatureRequests = new Map<string, { userId: string; channelId: string; ts: number }>();

export type RoutingDecision =
  | { kind: 'reject_unconfigured' }
  | { kind: 'follow_up' }
  | { kind: 'reject_invalid_intent'; intent: V2Intent; role: ChannelRole }
  | { kind: 'route'; intent: V2Intent; role: ChannelRole };

export interface RouteInput {
  channelId: string;
  threadTs: string | undefined; // undefined for top-level messages
  isExistingSageThread: boolean;
  intent: V2Intent;
}

/**
 * Pure routing decision — given the channel, thread state, and resolved
 * intent, decide what to do. Extracted from the Slack listener so the
 * routing logic is unit-testable without spinning up Bolt.
 */
export function decideRoute(input: RouteInput): RoutingDecision {
  const role = roleForChannel(input.channelId);
  if (role === null) {
    return { kind: 'reject_unconfigured' };
  }

  if (input.isExistingSageThread) {
    return { kind: 'follow_up' };
  }

  // Validate intent against role
  if (role === 'alerts') {
    if (input.intent === 'work_request' || input.intent === 'light_qc') {
      return { kind: 'reject_invalid_intent', intent: input.intent, role };
    }
  }

  return { kind: 'route', intent: input.intent, role };
}

/**
 * Look up whether a (channel, thread) pair already has a Sage-owned
 * request. Returns true once US-011 has persisted a request_record
 * for that channel + thread; false otherwise.
 */
export async function isExistingSageThread(
  channelId: string,
  threadTs: string | undefined,
): Promise<boolean> {
  if (!threadTs) return false;
  const { getRequestByThread } = await import('../lib/db');
  const record = await getRequestByThread(channelId, threadTs);
  return record !== null;
}

/**
 * True when the @mention text is a request for help / capabilities.
 * Matched as a fast-path before the LLM classifier.
 */
export function isHelpRequest(rawText: string): boolean {
  const text = rawText
    .replace(/^<@[A-Z0-9]+>\s*/, '')
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text === 'help' ||
    /^what\s+can\s+you\s+do\b/.test(text) ||
    /^how\s+(do\s+i|can\s+i|to)\s+use\b/.test(text)
  );
}

export function isScheduleRequest(rawText: string): boolean {
  const text = rawText.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  return /\b(schedule|book)\s+(a\s+)?(call|meeting|time)\b/i.test(text) ||
    /\bi\s+need\s+to\s+talk\s+to\s+marketing\b/i.test(text) ||
    /\bcan\s+i\s+(talk|speak|chat)\s+(to|with)\s+marketing\b/i.test(text);
}

export function isBugReport(rawText: string): boolean {
  const text = rawText.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  return /\b(found\s+a?\s*bug|report\s+a?\s*bug|bug\s+report|something('?s|\s+is)\s+(broken|wrong|not\s+working))\b/i.test(text);
}

export function isFeatureRequest(rawText: string): boolean {
  const text = rawText.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  return /\b(feature\s+(request|idea|suggestion)|suggest\s+(a\s+)?(feature|improvement|upgrade|change)|i('d|\s+would)\s+like\s+to\s+suggest|have\s+a\s+(feature\s+)?(idea|suggestion)|idea\s+for\s+(sage|the\s+bot|an?\s+upgrade|an?\s+improvement))\b/i.test(text);
}

export function isPrintRequest(rawText: string): boolean {
  const text = rawText.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  return /\b(print(ing|ed)?|physical\s+cop(y|ies)|hard\s+cop(y|ies))\b/i.test(text) &&
    /\b(material(s)?|flyer(s)?|brochure(s)?|banner(s)?|poster(s)?|handout(s)?|card(s)?|sheet(s)?|copies|packet(s)?|folder(s)?|collateral)\b/i.test(text);
}

/**
 * Register the v2 channel router on the Bolt app. The handler:
 *   1. Filters out events from non-configured channels (delegates to
 *      the existing v3 mention handler).
 *   2. Detects existing-thread follow-ups.
 *   3. Classifies the intent via Haiku.
 *   4. Validates intent for the channel's role.
 *   5. Stub-routes to a handler (real handlers wired in later stories).
 */
export function registerChannelRouter(app: App): void {
  app.event('app_mention', async ({ event, say, client }) => {
    const channelId = event.channel;
    const text = event.text ?? '';
    const threadTs = event.thread_ts ?? event.ts;
    const userId = event.user ?? '';
    const rawFiles = 'files' in event ? ((event as any).files as any[]) : undefined;
    const files = (rawFiles ?? []).map((f: any) => ({
      id: f.id as string,
      name: (f.name as string) ?? (f.title as string) ?? 'file',
      permalink: (f.permalink as string) ?? '',
      url_private: (f.url_private as string) ?? '',
    }));

    const role = roleForChannel(channelId);
    if (role === null) {
      // Not a v2-managed channel — let the existing v3 mention handler
      // (which guards against double-handling by ALSO checking
      // roleForChannel and returning if non-null) take it.
      return;
    }

    // Fast-path commands — match before LLM classification.
    if (isHelpRequest(text)) {
      await say({ text: getHelpMessage(role), thread_ts: threadTs });
      return;
    }

    if (isScheduleRequest(text)) {
      const calUrl = process.env.MARKETING_LEAD_CALENDAR_URL;
      await say({
        text: calUrl
          ? `Here's a link to book time with marketing: <${calUrl}|Schedule a call>`
          : `DM <@${process.env.MARKETING_LEAD_SLACK_ID ?? 'the marketing team'}> to set up time.`,
        thread_ts: threadTs,
      });
      return;
    }

    if (isBugReport(text)) {
      pendingChannelBugReports.set(threadTs, { userId, channelId, ts: Date.now() });
      await say({
        text: "Got it — what happened? Reply here and I'll file it with marketing.",
        thread_ts: threadTs,
      });
      return;
    }

    // Pending bug report — this @mention is the user's description
    const pendingBug = pendingChannelBugReports.get(threadTs);
    if (pendingBug && Date.now() - pendingBug.ts < 10 * 60 * 1000) {
      pendingChannelBugReports.delete(threadTs);
      const description = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
      const alertChannel = findChannelsByRole('alerts')[0] ?? config.slackMarketingChannelId;
      const mondayItem = await createFeedbackItem({ kind: 'bug', description, submitterSlackUserId: userId }).catch(() => null);
      await client.chat.postMessage({
        channel: alertChannel,
        text: `:bug: *Bug report from <@${userId}>:*\n${description}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}`,
      });
      await say({ text: "Logged — marketing will look into it.", thread_ts: threadTs });
      return;
    }

    if (isFeatureRequest(text)) {
      pendingChannelFeatureRequests.set(threadTs, { userId, channelId, ts: Date.now() });
      await say({
        text: "Love it — what would you like to see? Reply here and I'll pass it along to marketing.",
        thread_ts: threadTs,
      });
      return;
    }

    if (isPrintRequest(text)) {
      await say({
        text: [
          "Printing is self-serve — here's how marketing can help:",
          '',
          '• *Marketing-owned assets* (logos, branded templates, official collateral): tag me with what you need and I\'ll pull the files, or say *@Sage I need [asset]* to file a request for print-ready files.',
          '• *Already in Canva?* You can order prints directly through Canva and have them shipped to any address — no middleman needed.',
          '• *Need a new design?* File a request and marketing will create print-ready files for you.',
          '',
          'What do you need?',
        ].join('\n'),
        thread_ts: threadTs,
      });
      return;
    }

    // Pending feature request — this @mention is the user's description
    const pendingFeature = pendingChannelFeatureRequests.get(threadTs);
    if (pendingFeature && Date.now() - pendingFeature.ts < 10 * 60 * 1000) {
      pendingChannelFeatureRequests.delete(threadTs);
      const description = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
      const alertChannel = findChannelsByRole('alerts')[0] ?? config.slackMarketingChannelId;
      const mondayItem = await createFeedbackItem({ kind: 'feature', description, submitterSlackUserId: userId }).catch(() => null);
      await client.chat.postMessage({
        channel: alertChannel,
        text: `:bulb: *Feature suggestion from <@${userId}>:*\n${description}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}`,
      });
      await say({ text: "Passed along — thanks for the idea!", thread_ts: threadTs });
      return;
    }

    const existingThread = await isExistingSageThread(channelId, event.thread_ts);
    const intent: V2Intent = await classifyChannelMention(text, role);

    const decision = decideRoute({
      channelId,
      threadTs: event.thread_ts,
      isExistingSageThread: existingThread,
      intent,
    });

    switch (decision.kind) {
      case 'reject_unconfigured':
        // Should not happen — already filtered above. Defensive.
        await say({
          text: "I'm not set up for this channel yet. Try a `#mktg_{your-division}_requests` channel for new requests.",
          thread_ts: threadTs,
        });
        return;

      case 'reject_invalid_intent':
        if (decision.intent === 'work_request') {
          await say({
            text: 'Requests come from division channels — try a `#mktg_{your-division}_requests` channel.',
            thread_ts: threadTs,
          });
        } else if (decision.intent === 'light_qc') {
          await say({
            text: 'Light QC runs in your division channel — try a `#mktg_{your-division}_requests` channel.',
            thread_ts: threadTs,
          });
        }
        return;

      case 'follow_up': {
        const { getRequestByThread } = await import('../lib/db');
        const record = await getRequestByThread(channelId, threadTs);
        if (!record) {
          // Shouldn't happen — isExistingSageThread already passed.
          await say({ text: 'Follow-up detected but the request record is missing.', thread_ts: threadTs });
          return;
        }
        await handlePostSubmissionFollowUp({
          client,
          record,
          text,
          userId,
          files,
          threadTs,
        });
        return;
      }

      case 'route':
        // Stubs — real handlers replace these in US-006/007/009/016.
        await routeIntentStub({
          intent: decision.intent,
          role: decision.role,
          channelId,
          threadTs,
          userId,
          text,
          say,
          client,
        });
        return;
    }
  });
}

interface RouteIntentStubInput {
  intent: V2Intent;
  role: ChannelRole;
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  say: (params: any) => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
}

async function routeIntentStub(input: RouteIntentStubInput): Promise<void> {
  const { intent, role, channelId, threadTs, userId, text, say, client } = input;

  switch (intent) {
    case 'info_lookup': {
      const body = getQuickInfoResponse(text);
      await say({ text: `${body}\n\n_Need something else? Just ask, or say *help* to see what I can do._`, thread_ts: threadTs });
      break;
    }
    case 'work_request':
      await postOpenModalButton({
        channelId,
        threadTs,
        text,
        say,
        channelDivision: divisionForChannel(channelId),
      });
      break;
    case 'status_query':
      await handleVisibilityQuery({
        text,
        channelId,
        threadTs,
        userSlackId: userId,
        role,
        say,
        client,
      });
      break;
    case 'light_qc':
      await handleLightQC({ text, threadTs, userId, channelId, say });
      break;
    case 'unclear':
      await say({
        text: "I'm not sure what you're asking — could you rephrase? For example: `@Sage I need a webinar email`, `@Sage what's our logo?`, or `@Sage where's my request?`",
        thread_ts: threadTs,
      });
      break;
  }

  await logRequestEvent({
    eventType: intent === 'work_request' ? 'modal_opened' : 'follow_up_received',
    userId,
    channelId,
    channelRole: role,
    intent,
  });
}
