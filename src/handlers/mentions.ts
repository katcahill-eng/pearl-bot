import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage } from './intake';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';
import { ConversationManager } from '../lib/conversation';

export function registerMentionHandler(app: App): void {
  app.event('app_mention', async ({ event, say, client }) => {
    const text = event.text ?? '';
    const thread_ts = event.thread_ts ?? event.ts;
    const userId = event.user ?? '';

    // Extract file attachments (rare in mentions but possible)
    const rawFiles = 'files' in event ? (event as any).files as any[] : undefined;
    const files = rawFiles?.map((f: any) => ({
      id: f.id as string,
      name: f.name as string ?? f.title as string ?? 'file',
      permalink: f.permalink as string ?? f.url_private as string ?? '',
    }));

    console.log(`[mentions] Received app_mention from ${userId} in channel ${event.channel}: "${text.substring(0, 80)}" event.ts=${event.ts} event.thread_ts=${event.thread_ts ?? 'NONE'} → using thread_ts=${thread_ts}`);

    // Channel restriction — only respond in the allowed channel (if configured)
    const allowedChannel = process.env.ALLOWED_CHANNEL_ID;
    if (allowedChannel && event.channel !== allowedChannel) {
      console.log(`[mentions] Ignoring mention in channel ${event.channel} (allowed: ${allowedChannel})`);
      return;
    }

    try {
      // For threaded mentions, check if the thread already has a conversation owned by another user
      if (event.thread_ts && userId) {
        const existingConvo = await ConversationManager.load(userId, thread_ts);
        if (existingConvo && existingConvo.getUserId() !== userId) {
          console.log(`[mentions] Ignoring mention from non-owner ${userId} in thread ${thread_ts} (owner: ${existingConvo.getUserId()})`);
          return;
        }
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
            messageTs: event.ts,
            text,
            files,
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
