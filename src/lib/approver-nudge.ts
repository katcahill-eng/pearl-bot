/**
 * Sage v2 approver nudge scheduler.
 *
 * When a request is in "Pending review" and approvers haven't acted,
 * DMs are sent at 24, 48, and 72 *business* hours (weekends excluded).
 * Each approver gets at most one DM per nudge level per request.
 */

import type { WebClient } from '@slack/web-api';
import {
  getPendingApproverNudges,
  recordApproverNudge,
} from './db';
import { logRequestEvent } from './event-log';
import { trackError } from './error-tracker';

const NUDGE_INTERVAL_MS = 60 * 60 * 1000; // check every hour

const NUDGE_COPY: Record<1 | 2 | 3, (summary: string, requesterUserId: string, permalink: string) => string> = {
  1: (summary, requester, link) =>
    `Heads up — <@${requester}> is waiting on your review for "${summary}". ${link ? `Take a look here: <${link}>` : ''}`.trim(),
  2: (summary, requester, link) =>
    `Reminder: <@${requester}>'s request ("${summary}") still needs your approval. ${link ? `<${link}>` : ''}`.trim(),
  3: (summary, requester, link) =>
    `Final reminder: <@${requester}>'s request ("${summary}") has been waiting 72 business hours for your approval. ${link ? `<${link}>` : ''}`.trim(),
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startApproverNudgeScheduler(client: WebClient): void {
  const tick = async () => {
    try {
      const pending = await getPendingApproverNudges();
      let dmsSent = 0;
      for (const item of pending) {
        for (const approverUserId of item.pending_approver_user_ids) {
          try {
            await sendApproverNudge(client, item.request, approverUserId, item.nudgeLevel);
            await recordApproverNudge(item.request.id, approverUserId, item.nudgeLevel);
            dmsSent++;
          } catch (err) {
            console.error('[approver-nudge] DM failed:', err);
            await trackError(err, undefined, {
              source: 'approver-nudge',
              request: item.request.id.toString(),
              approver: approverUserId,
            });
          }
        }
      }
      if (dmsSent > 0) {
        console.log(`[approver-nudge] Sent ${dmsSent} nudge(s)`);
      }
    } catch (err) {
      console.error('[approver-nudge] tick failed:', err);
      await trackError(err, undefined, { source: 'approver-nudge-tick' });
    }
  };

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[approver-nudge] tick error:', err));
  }, NUDGE_INTERVAL_MS);

  console.log('[approver-nudge] scheduler started (1h interval, 24/48/72h business-hour thresholds)');
}

export function stopApproverNudgeScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function sendApproverNudge(
  client: WebClient,
  request: {
    id: number;
    monday_item_id: string;
    originating_channel_id: string;
    originating_thread_ts: string;
    requester_user_id: string;
    deliverable_summary: string | null;
  },
  approverUserId: string,
  nudgeLevel: 1 | 2 | 3 = 1,
): Promise<void> {
  let permalink = '';
  try {
    const result = await client.chat.getPermalink({
      channel: request.originating_channel_id,
      message_ts: request.originating_thread_ts,
    });
    permalink = result.permalink ?? '';
  } catch {
    // Best-effort; DM still goes without a deep link.
  }

  const summary = (request.deliverable_summary ?? 'a marketing request').slice(0, 100);
  const text = NUDGE_COPY[nudgeLevel](summary, request.requester_user_id, permalink);

  await client.chat.postMessage({
    channel: approverUserId,
    text,
  });

  await logRequestEvent({
    eventType: 'approver_nudged_dm',
    userId: approverUserId,
    mondayItemId: request.monday_item_id,
  });
}
