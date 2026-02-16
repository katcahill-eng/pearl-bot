import type { WebClient } from '@slack/web-api';
import {
  getTimedOutConversations,
  getAutoCancelConversations,
  markTimeoutNotified,
  cancelConversation,
  logConversationMetrics,
  type Conversation,
} from '../lib/db';

/**
 * Check for timed-out conversations and send reminder messages or auto-cancel.
 * Should be called on a regular interval (e.g., every 15 minutes).
 */
export async function checkTimeouts(client: WebClient): Promise<void> {
  // Phase 1: Auto-cancel conversations that were already notified 24h ago
  try {
    const autoCancel = await getAutoCancelConversations();
    for (const convo of autoCancel) {
      await cancelConversation(convo.id);
      const durationSeconds = convo.created_at ? Math.round((Date.now() - new Date(convo.created_at).getTime()) / 1000) : null;
      logConversationMetrics({ conversationId: convo.id, userId: convo.user_id, finalStatus: 'timeout', durationSeconds, classification: convo.classification }).catch(() => {});
      console.log(`[timeout] Auto-cancelled conversation ${convo.id} for user ${convo.user_id}`);
    }
  } catch (err) {
    console.error('[timeout] Error auto-cancelling conversations:', err);
  }

  // Phase 2: Send timeout messages for newly expired conversations
  try {
    const timedOut = await getTimedOutConversations();
    for (const convo of timedOut) {
      await sendTimeoutMessage(client, convo);
      await markTimeoutNotified(convo.id);
      console.log(`[timeout] Sent timeout message for conversation ${convo.id} to user ${convo.user_id}`);
    }
  } catch (err) {
    console.error('[timeout] Error sending timeout messages:', err);
  }
}

async function sendTimeoutMessage(client: WebClient, convo: Conversation): Promise<void> {
  const collectedSummary = buildCollectedSummary(convo.collected_data);

  const message = [
    `Hey! We started a marketing request yesterday but didn't finish.`,
    '',
    collectedSummary ? `Here's what I have so far:\n${collectedSummary}\n` : '',
    'What would you like to do?',
    '• Reply *continue* to pick up where we left off',
    '• Reply *start over* to begin fresh',
    '• Reply *cancel* to drop this request',
    '',
    "_If I don't hear back, I'll close this out automatically._",
  ]
    .filter((line) => line !== '' || true) // keep blank lines for spacing
    .join('\n');

  try {
    await client.chat.postMessage({
      channel: convo.channel_id,
      thread_ts: convo.thread_ts,
      text: message,
    });
  } catch (err) {
    console.error(`[timeout] Failed to send timeout message to channel ${convo.channel_id}, thread ${convo.thread_ts}:`, err);
  }
}

function buildCollectedSummary(collectedDataJson: string): string {
  try {
    const data = JSON.parse(collectedDataJson);
    const lines: string[] = [];

    if (data.requester_department) lines.push(`• *Department:* ${data.requester_department}`);
    if (data.target) lines.push(`• *Target:* ${data.target}`);
    if (data.context_background) lines.push(`• *Context:* ${data.context_background}`);
    if (data.desired_outcomes) lines.push(`• *Desired outcomes:* ${data.desired_outcomes}`);
    if (data.deliverables?.length > 0) lines.push(`• *Deliverables:* ${data.deliverables.join(', ')}`);
    if (data.due_date) lines.push(`• *Due date:* ${data.due_date}`);

    return lines.length > 0 ? lines.join('\n') : '';
  } catch {
    return '';
  }
}
