import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage } from './intake';
import { handleDocumentReviewMessage } from './document-review';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';
import { handleQuickInfo } from './quick-info';
import { ConversationManager } from '../lib/conversation';
import { config } from '../lib/config';

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

    // --- DM handling: redirect to channel ---
    if (isDM) {
      try {
        const intent = detectIntent(text);

        // Quick info works anywhere — one-shot answers
        if (intent === 'quick_info') {
          await handleQuickInfo({ text, threadTs: thread_ts, say });
          return;
        }

        // Help: show help message + channel redirect
        if (intent === 'help') {
          await say({
            text: getHelpMessage() + `\n\nHead to <#${config.slackMarketingChannelId}> to get started — no @mention needed!`,
            thread_ts,
          });
          return;
        }

        // Everything else: redirect to the bot channel
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
