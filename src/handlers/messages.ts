import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage } from './intake';
import { handleDocumentReviewMessage } from './document-review';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';
import { handleQuickInfo } from './quick-info';
import { ConversationManager } from '../lib/conversation';
import { getActiveConversationForUser } from '../lib/db';
import { config } from '../lib/config';
import { roleForChannel, findChannelsByRole } from '../lib/division-lookup';
import { pendingChannelBugReports, pendingChannelFeatureRequests, isFeatureRequest, isBugReport } from './channel-router';
import { resolveMondayUserId } from '../lib/slack-monday-bridge';
import { createFeedbackItem } from '../lib/monday';

// Tracks users who said "help"/"feature idea" in a DM and are about to describe their issue.
// Keyed by userId, value is the timestamp of the trigger message.
const pendingBugReports = new Map<string, number>();
const pendingFeatureDMs = new Map<string, number>();

// --- Per-thread message debounce ---
// When users send multiple messages quickly ("Yeah" + "here"), only process
// the last one. Each new message cancels the previous pending message for
// the same thread+user, ensuring only the final message gets processed.
const pendingDebounce = new Map<string, () => void>();
const DEBOUNCE_MS = 800;

function debounceMessage(threadTs: string, userId: string): Promise<boolean> {
  const key = `${threadTs}:${userId}`;

  // Cancel the previously pending message for this thread+user
  const cancelPrevious = pendingDebounce.get(key);
  if (cancelPrevious) {
    console.log(`[messages] Debounce: newer message arrived for thread ${threadTs}, superseding previous`);
    cancelPrevious();
  }

  return new Promise<boolean>((resolve) => {
    const cancel = () => {
      pendingDebounce.delete(key);
      resolve(false); // Skip — a newer message superseded this one
    };
    pendingDebounce.set(key, cancel);

    setTimeout(() => {
      // If still pending (not cancelled by a newer message), process this one
      if (pendingDebounce.get(key) === cancel) {
        pendingDebounce.delete(key);
        resolve(true); // Process this message
      }
    }, DEBOUNCE_MS);
  });
}

export function registerMessageHandler(app: App): void {
  app.event('message', async ({ event, say, client }) => {
    if (event.subtype) return; // Skip edits, deletes, bot messages, etc.
    if ('bot_id' in event && event.bot_id) return; // Skip bot messages without subtype

    // v2: configured intake/alerts/test channels are owned by
    // channel-router.ts (which listens for app_mention, not message).
    // Skip them here so the v3 message handler doesn't double-handle
    // when a user @mentions Sage and Slack fires both events.
    // Exception: plain thread replies when a bug/feature report is pending.
    if (event.channel && roleForChannel(event.channel) !== null) {
      const replyThreadTs = 'thread_ts' in event ? event.thread_ts : undefined;
      // Only intercept actual replies — not the triggering message itself.
      // When thread_ts equals ts, this IS the root message, not a reply.
      const isActualReply = replyThreadTs && replyThreadTs !== event.ts;
      const pendingBug = isActualReply ? pendingChannelBugReports.get(replyThreadTs!) : undefined;
      const pendingFeature = isActualReply ? pendingChannelFeatureRequests.get(replyThreadTs!) : undefined;
      const reportUserId = 'user' in event ? (event.user as string) : '';
      const description = (event.text ?? '').replace(/^<@[A-Z0-9]+>\s*/, '').trim();
      const alertChannel = findChannelsByRole('alerts')[0] ?? config.slackMarketingChannelId;

      if (pendingBug && Date.now() - pendingBug.ts < 10 * 60 * 1000 && description) {
        pendingChannelBugReports.delete(replyThreadTs!);
        try {
          const [permalink, mondayUserId] = await Promise.all([
            client.chat.getPermalink({ channel: event.channel, message_ts: replyThreadTs! }).catch(() => null),
            resolveMondayUserId(reportUserId, client),
          ]);
          const threadLink = (permalink as any)?.permalink;
          const mondayItem = await createFeedbackItem({ kind: 'bug', description, submitterSlackUserId: reportUserId, mondayUserId, submissionLink: threadLink }).catch(() => null);
          await client.chat.postMessage({ channel: alertChannel, text: `:bug: *Bug report from <@${reportUserId}>:*\n${description}${threadLink ? `\n<${threadLink}|View thread>` : ''}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}` });
          await say({ text: "Logged — marketing will look into it.", thread_ts: replyThreadTs });
        } catch (err) { console.error('[messages] Failed to file bug report:', err); }
      } else if (pendingFeature && Date.now() - pendingFeature.ts < 10 * 60 * 1000 && description) {
        pendingChannelFeatureRequests.delete(replyThreadTs!);
        try {
          const [permalink, mondayUserId] = await Promise.all([
            client.chat.getPermalink({ channel: event.channel, message_ts: replyThreadTs! }).catch(() => null),
            resolveMondayUserId(reportUserId, client),
          ]);
          const threadLink = (permalink as any)?.permalink;
          const mondayItem = await createFeedbackItem({ kind: 'feature', description, submitterSlackUserId: reportUserId, mondayUserId, submissionLink: threadLink }).catch(() => null);
          await client.chat.postMessage({ channel: alertChannel, text: `:bulb: *Feature suggestion from <@${reportUserId}>:*\n${description}${threadLink ? `\n<${threadLink}|View thread>` : ''}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}` });
          await say({ text: "Passed along — thanks for the idea!", thread_ts: replyThreadTs });
        } catch (err) { console.error('[messages] Failed to file feature request:', err); }
      }
      return;
    }

    const isDM = event.channel_type === 'im';
    const isInBotChannel = event.channel === config.slackMarketingChannelId;
    const isThreadReply = 'thread_ts' in event && event.thread_ts !== undefined;
    const text = event.text ?? '';
    const messageTs = event.ts;
    const thread_ts = event.thread_ts ?? event.ts;
    const userId = 'user' in event ? (event.user as string) : '';

    // Extract file attachments from Slack event
    const rawFiles = 'files' in event ? (event as any).files as any[] : undefined;
    const files = rawFiles?.map((f: any) => ({
      id: f.id as string,
      name: f.name as string ?? f.title as string ?? 'file',
      permalink: f.permalink as string ?? f.url_private as string ?? '',
      urlPrivate: (f.url_private as string) ?? '',
    }));

    console.log(`[messages] Message from ${userId} in ${isDM ? 'DM' : 'channel'} (thread=${isThreadReply}, inBotChannel=${isInBotChannel}): "${text.substring(0, 80)}" thread_ts=${thread_ts}`);

    // --- DM handling ---
    if (isDM) {
      try {
        const intent = detectIntent(text);

        // Quick info works anywhere — one-shot answers
        if (intent === 'quick_info') {
          await handleQuickInfo({ text, threadTs: thread_ts, say });
          return;
        }

        // "help" → show help and redirect to channels for requests
        if (intent === 'help') {
          await say({
            text: `Hey — for marketing requests, head to your division's requests channel. I can also help with:\n• Bug reports or feedback — just describe the issue and I'll pass it along\n• Brand info (logos, colors, guidelines) — ask me anytime`,
            thread_ts,
          });
          return;
        }

        // Bug report
        if (isBugReport(text)) {
          pendingBugReports.set(userId, Date.now());
          await say({
            text: "Got it — what happened? Give me a quick description and I'll pass it along to marketing.",
            thread_ts,
          });
          return;
        }

        // Feature request
        if (isFeatureRequest(text)) {
          pendingFeatureDMs.set(userId, Date.now());
          await say({
            text: "Love it — what would you like to see? Give me a quick description and I'll pass it along to marketing.",
            thread_ts,
          });
          return;
        }

        // Pending bug/feature report — user is describing their issue
        const pendingEntry = pendingBugReports.get(userId) ?? pendingFeatureDMs.get(userId);
        const isBug = !!pendingBugReports.get(userId);
        if (pendingEntry && Date.now() - pendingEntry < 10 * 60 * 1000) {
          pendingBugReports.delete(userId);
          pendingFeatureDMs.delete(userId);
          const alertChannel = findChannelsByRole('alerts')[0] ?? config.slackMarketingChannelId;
          const [permalink, mondayUserId] = await Promise.all([
            client.chat.getPermalink({ channel: event.channel, message_ts: thread_ts }).catch(() => null),
            resolveMondayUserId(userId, client),
          ]);
          const threadLink = (permalink as any)?.permalink;
          const mondayItem = await createFeedbackItem({ kind: isBug ? 'bug' : 'feature', description: text, submitterSlackUserId: userId, mondayUserId, submissionLink: threadLink }).catch(() => null);
          await client.chat.postMessage({
            channel: alertChannel,
            text: isBug
              ? `:bug: *Bug report from <@${userId}>:*\n${text}${threadLink ? `\n<${threadLink}|View thread>` : ''}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}`
              : `:bulb: *Feature suggestion from <@${userId}>:*\n${text}${threadLink ? `\n<${threadLink}|View thread>` : ''}${mondayItem ? `\n<${mondayItem.url}|View in Monday>` : ''}`,
          });
          const calUrl = process.env.MARKETING_LEAD_CALENDAR_URL;
          const calLink = calUrl ? ` or <${calUrl}|schedule a quick call>` : '';
          await say({
            text: isBug
              ? `Logged — marketing will look into it.${calLink ? ` In the meantime, feel free to${calLink} if you need faster help.` : ''}`
              : `Passed along — thanks for the idea!${calLink ? ` Feel free to${calLink} if you'd like to discuss it.` : ''}`,
            thread_ts,
          });
          return;
        }

        // Everything else: redirect to the intake channel
        await say({
          text: `Hey! I work best in <#${config.slackMarketingChannelId}>. Head over there and tell me what you need — no @mention needed, I'll pick it up automatically.`,
          thread_ts,
        });
      } catch (err) {
        console.error('[messages] Error handling DM:', err);
        try {
          await say({
            text: "Something went wrong on my end. Your info hasn't been lost — you can try again, use the intake form, or tag someone from the marketing team in #marcoms-requests for help.",
            thread_ts,
          });
        } catch (sayErr) {
          console.error('[messages] Failed to send error message to user:', sayErr);
        }
      }
      return;
    }

    // --- Only respond in the dedicated bot channel ---
    if (!isInBotChannel) return;

    try {
      // Debounce rapid messages in threads
      if (isThreadReply) {
        const shouldProcess = await debounceMessage(thread_ts, userId);
        if (!shouldProcess) {
          console.log(`[messages] Skipping superseded message "${text.substring(0, 40)}" in thread ${thread_ts}`);
          return;
        }
      }

      // --- Thread replies: route to existing conversation ---
      if (isThreadReply) {
        const existingConvo = await ConversationManager.load(userId, thread_ts);

        // Check ownership: only respond if this thread belongs to this user
        if (existingConvo && existingConvo.getUserId() !== userId) {
          console.log(`[messages] Ignoring message from non-owner ${userId} in thread ${thread_ts} (owner: ${existingConvo.getUserId()})`);
          return;
        }

        // Route to document review if that's what this conversation is
        if (existingConvo && existingConvo.getCurrentStep()?.startsWith('doc_review:')) {
          console.log(`[messages] Routing thread reply to document-review handler, thread=${thread_ts}`);
          await handleDocumentReviewMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: thread_ts,
            text,
            files,
            say,
            client,
          });
          return;
        }

        // No active conversation — run intent detection before defaulting to intake
        const isTerminal = existingConvo && ['cancelled', 'complete', 'withdrawn'].includes(existingConvo.getStatus());
        if (!existingConvo || isTerminal) {
          const threadIntent = detectIntent(text);
          console.log(`[messages] Thread reply with ${isTerminal ? 'terminal' : 'no'} conversation, intent=${threadIntent}, thread=${thread_ts}`);

          if (threadIntent === 'quick_info') {
            await handleQuickInfo({ text, threadTs: thread_ts, say });
            return;
          }

          if (threadIntent === 'help') {
            await say({ text: getHelpMessage(), thread_ts });
            return;
          }

          if (threadIntent === 'status') {
            await handleStatusCheck({ text, threadTs: thread_ts, say });
            return;
          }

          if (threadIntent === 'search') {
            await handleSearchRequest({ text, threadTs: thread_ts, say });
            return;
          }

          if (threadIntent === 'document_review') {
            await handleDocumentReviewMessage({
              userId,
              userName: userId,
              channelId: event.channel,
              threadTs: thread_ts,
              text,
              files,
              say,
              client,
            });
            return;
          }
        }

        // Route to intake handler (handles all states including recovery)
        console.log(`[messages] Routing thread reply to intake handler, thread=${thread_ts}`);
        await handleIntakeMessage({
          userId,
          userName: userId,
          channelId: event.channel,
          threadTs: thread_ts,
          messageTs,
          text,
          files,
          say,
          client,
        });
        return;
      }

      // --- New top-level message in the bot channel ---
      const intent = detectIntent(text);

      // For greetings/help: if the user has an active open request elsewhere,
      // route to intake so the duplicate-check flow kicks in ("continue there or start fresh?")
      if (intent === 'help') {
        const activeConvo = await getActiveConversationForUser(userId, messageTs);
        if (activeConvo) {
          console.log(`[messages] User has active conversation (id=${activeConvo.id}), routing hello to intake for dup check`);
          await handleIntakeMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: messageTs,
            messageTs,
            text,
            files,
            say,
            client,
          });
          return;
        }
      }

      switch (intent) {
        case 'help':
          await say({ text: getHelpMessage(), thread_ts: messageTs });
          break;

        case 'quick_info':
          await handleQuickInfo({ text, threadTs: messageTs, say });
          break;

        case 'status':
          await handleStatusCheck({ text, threadTs: messageTs, say });
          break;

        case 'search':
          await handleSearchRequest({ text, threadTs: messageTs, say });
          break;

        case 'document_review':
          await handleDocumentReviewMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: messageTs,
            text,
            files,
            say,
            client,
          });
          break;

        case 'intake':
        default:
          await handleIntakeMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: messageTs,
            messageTs,
            text,
            files,
            say,
            client,
          });
          break;
      }
    } catch (err) {
      console.error('[messages] Unhandled error in message handler:', err);
      try {
        await say({
          text: "Something went wrong on my end. Your info hasn't been lost — you can try again, use the intake form, or tag someone from the marketing team in #marcoms-requests for help.",
          thread_ts,
        });
      } catch (sayErr) {
        console.error('[messages] Failed to send error message to user:', sayErr);
      }
    }
  });
}
