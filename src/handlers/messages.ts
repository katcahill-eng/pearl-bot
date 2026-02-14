import type { App } from '@slack/bolt';
import { detectIntent, getHelpMessage } from './intent';
import { handleIntakeMessage } from './intake';
import { handleStatusCheck } from './status';
import { handleSearchRequest } from './search';
import { ConversationManager } from '../lib/conversation';

export function registerMessageHandler(app: App): void {
  app.event('message', async ({ event, say, client }) => {
    if (event.subtype) return; // Skip edits, deletes, bot messages, etc.
    if ('bot_id' in event && event.bot_id) return; // Skip bot messages without subtype

    const isDM = event.channel_type === 'im';
    const isThreadReply = 'thread_ts' in event && event.thread_ts !== undefined;

    // Only handle DMs and thread replies in channels (where conversations happen)
    if (!isDM && !isThreadReply) return;

    const text = event.text ?? '';
    const messageTs = event.ts;
    const thread_ts = event.thread_ts ?? event.ts;
    const userId = 'user' in event ? (event.user as string) : '';

    console.log(`[messages] Message from ${userId} in ${isDM ? 'DM' : 'channel'} (thread=${isThreadReply}): "${text.substring(0, 80)}" thread_ts=${thread_ts}`);

    // For channel thread replies, only handle if there's an active conversation owned by this user
    if (!isDM) {
      try {
        console.log(`[messages] Channel thread reply: loading conversation for userId=${userId}, thread_ts=${thread_ts}`);
        const existingConvo = await ConversationManager.load(userId, thread_ts);
        if (!existingConvo) {
          console.log(`[messages] No active conversation in thread ${thread_ts}, ignoring channel message`);
          return;
        }
        console.log(`[messages] Loaded conversation id=${existingConvo.getId()} owner=${existingConvo.getUserId()} status=${existingConvo.getStatus()} step=${existingConvo.getCurrentStep()}`);
        // Ignore messages from users who don't own this conversation
        if (existingConvo.getUserId() !== userId) {
          console.log(`[messages] Ignoring message from non-owner ${userId} in thread ${thread_ts} (owner: ${existingConvo.getUserId()})`);
          return;
        }
        const status = existingConvo.getStatus();
        if (status !== 'gathering' && status !== 'confirming' && status !== 'pending_approval' && status !== 'complete') {
          console.log(`[messages] Conversation in thread ${thread_ts} has status ${status}, ignoring`);
          return;
        }
        console.log(`[messages] Found active conversation in thread ${thread_ts}, routing to intake`);
        await handleIntakeMessage({
          userId,
          userName: userId,
          channelId: event.channel,
          threadTs: thread_ts,
          messageTs,
          text,
          say,
          client,
        });
      } catch (err) {
        console.error(`[messages] Error handling channel thread reply in ${thread_ts}:`, err);
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

    // --- DM handling below ---
    try {
      // Check if there's an active conversation in this thread — if so, route directly to intake
      const existingConvo = await ConversationManager.load(userId, thread_ts);
      if (existingConvo) {
        const status = existingConvo.getStatus();
        if (status === 'gathering' || status === 'confirming' || status === 'pending_approval' || status === 'complete') {
          await handleIntakeMessage({
            userId,
            userName: userId,
            channelId: event.channel,
            threadTs: thread_ts,
            messageTs,
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
            messageTs,
            text,
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
