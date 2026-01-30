import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage, hasPendingDuplicateCheck } from './intake';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';

export function registerMentionHandler(app: App): void {
  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text ?? '';
    const thread_ts = event.thread_ts ?? event.ts;
    const userId = event.user ?? '';

    // Channel restriction — only respond in the allowed channel (if configured)
    const allowedChannel = process.env.ALLOWED_CHANNEL_ID;
    if (allowedChannel && event.channel !== allowedChannel) {
      console.log(`[mentions] Ignoring mention in channel ${event.channel} (allowed: ${allowedChannel})`);
      return;
    }

    try {
      // Check if there's a pending duplicate-thread prompt — route to intake to handle the response
      if (userId && hasPendingDuplicateCheck(userId, thread_ts)) {
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
            userId: event.user ?? '',
            userName: event.user ?? '',
            channelId: event.channel,
            threadTs: thread_ts,
            text,
            say,
            client,
          });
          break;
      }
    } catch (err) {
      console.error('[mentions] Unhandled error in app_mention handler:', err);
      try {
        await say({
          text: "Something went wrong on my end. Your info hasn't been lost — you can try again, use the intake form, or tag someone from the marketing team in #marcoms-requests for help.",
          thread_ts,
        });
      } catch (sayErr) {
        console.error('[mentions] Failed to send error message to user:', sayErr);
      }
    }
  });
}
