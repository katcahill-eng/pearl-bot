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
import { roleForChannel, divisionForChannel, type ChannelRole } from '../lib/division-lookup';
import { classifyChannelMention, type V2Intent } from '../lib/v2-classifier';
import { logRequestEvent } from '../lib/event-log';
import { getQuickInfoResponse } from './quick-info';
import { handleLightQC } from './light-qc';
import { postOpenModalButton } from './intake-modal';
import { getHelpMessage } from './intent';
import { handleVisibilityQuery } from './visibility-query';
import { handlePostSubmissionFollowUp } from './post-submission';

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

    // Help command — match before LLM classification to save a Haiku
    // call for the trivial case.
    if (isHelpRequest(text)) {
      await say({ text: getHelpMessage(role), thread_ts: threadTs });
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
}

async function routeIntentStub(input: RouteIntentStubInput): Promise<void> {
  const { intent, role, channelId, threadTs, userId, text, say } = input;

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
