import type { WebClient } from '@slack/web-api';
import { getStaleTriageConversations, incrementTriageReminderCount } from './db';

/**
 * Check for stale triage items and post reminders.
 * A triage item is "stale" if it's been in pending_approval for 1+ business days
 * with no status change.
 *
 * Called daily at 9am ET from the main scheduler.
 */
export async function checkStaleTriage(client: WebClient): Promise<void> {
  try {
    const staleConversations = await getStaleTriageConversations();

    if (staleConversations.length === 0) {
      console.log('[stale-triage] No stale triage items found');
      return;
    }

    console.log(`[stale-triage] Found ${staleConversations.length} stale triage item(s)`);

    for (const convo of staleConversations) {
      const triageTs = convo.triage_message_ts;
      const triageChannelId = convo.triage_channel_id;

      if (!triageTs || !triageChannelId) continue;

      const days = businessDaysSince(new Date(convo.updated_at));
      if (days < 1) continue; // Not stale enough

      try {
        await client.chat.postMessage({
          channel: triageChannelId,
          text: `:warning: This request has been in triage for ${days} business day${days > 1 ? 's' : ''} with no status change.`,
          thread_ts: triageTs,
        });

        await incrementTriageReminderCount(convo.id);
        console.log(`[stale-triage] Reminded triage for conversation ${convo.id} (${days} business day${days > 1 ? 's' : ''})`);
      } catch (err) {
        console.error(`[stale-triage] Failed to post reminder for conversation ${convo.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[stale-triage] Check failed:', err);
  }
}

/**
 * Calculate the number of business days (Mon–Fri) between a date and now.
 * Uses America/New_York timezone for consistency with the daily digest.
 */
export function businessDaysSince(date: Date): number {
  const now = new Date();

  // Convert both to ET date strings for comparison
  const startET = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nowET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // Normalize to start of day
  startET.setHours(0, 0, 0, 0);
  nowET.setHours(0, 0, 0, 0);

  let count = 0;
  const current = new Date(startET);

  while (current < nowET) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    // Skip Saturday (6) and Sunday (0)
    if (day !== 0 && day !== 6) {
      count++;
    }
  }

  return count;
}
