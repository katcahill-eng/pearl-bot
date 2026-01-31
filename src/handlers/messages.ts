import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage, hasPendingDuplicateCheck } from './intake';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';
import { ConversationManager } from '../lib/conversation';

export function registerMessageHandler(app: App): void {
  app.event('message', async ({ event, say, client }) => {
    // Only handle DMs (message.im) — ignore channel messages, edits, and bot messages
    if (event.channel_type !== 'im') return;
    if (event.subtype) {
      console.log(`[messages] Skipping DM with subtype: ${event.subtype}`);
      return;
    }

    const text = event.text ?? '';
    const thread_ts = event.thread_ts ?? event.ts;
    const userId = 'user' in event ? (event.user as string) : '';

    console.log(`[messages] DM received from ${userId}: "${text.substring(0, 80)}" thread_ts=${thread_ts} event.thread_ts=${event.thread_ts ?? 'none'} event.ts=${event.ts}`);

    try {
      // Check if there's a pending duplicate-thread prompt — route to intake to handle the response
      if (hasPendingDuplicateCheck(userId, thread_ts)) {
        await handleIntakeMessage({
          userId,
          userName: userId,
          channelId: event.channel,
          threadTs: thread_ts,
          text,
          say,
          client,
        });
        return;
      }

      // Check if there's an active conversation in this thread — if so, route directly to intake
      const existingConvo = ConversationManager.load(userId, thread_ts);
      if (existingConvo) {
        const status = existingConvo.getStatus();
        if (status === 'gathering' || status === 'confirming') {
          await handleIntakeMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: thread_ts,
            text,
            say,
            client,
          });
          return;
        }
      }

      // No active conversation — use intent detection
      const intent = detectIntent(text);

      switch (intent) {
        case 'help':
          await say({ text: getHelpMessage(), thread_ts });
          break;

        case 'status':
          await handleStatusCheck({ text, threadTs: thread_ts, say });
          break;

        case 'search':
          await handleSearchRequest({ text, threadTs: thread_ts, say });
          break;

        case 'intake':
        default:
          await handleIntakeMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: thread_ts,
            text,
            say,
            client,
          });
          break;
      }
    } catch (err) {
      console.error('[messages] Unhandled error in DM handler:', err);
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
