/**
 * Sage v2 48-hour approver nudge.
 *
 * Per PRD US-017 (renumbered as US-023 in prd.json): if an approver
 * hasn't acted on a request after 48 hours, DM them a deep-link back
 * to the originating channel thread so they can approve from the
 * channel. Each approver gets at most ONE nudge per request — tracked
 * in the request_approver_nudges table.
 *
 * The 48-hour DM is the only legitimate staff-facing DM use case in
 * v2 (the other DM use case is the maintainer weekly digest, US-024).
 */

import type { WebClient } from '@slack/web-api';
import {
  getPendingApproverNudges,
  recordApproverNudge,
} from './db';
import { logRequestEvent } from './event-log';
import { trackError } from './error-tracker';

const NUDGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const NUDGE_THRESHOLD_HOURS = 48;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startApproverNudgeScheduler(client: WebClient): void {
  const tick = async () => {
    try {
      const pending = await getPendingApproverNudges(NUDGE_THRESHOLD_HOURS);
      let dmsSent = 0;
      for (const item of pending) {
        for (const approverUserId of item.pending_approver_user_ids) {
          try {
            await sendApproverNudge(client, item.request, approverUserId);
            await recordApproverNudge(item.request.id, approverUserId);
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
        console.log(`[approver-nudge] Sent ${dmsSent} nudges`);
      }
    } catch (err) {
      console.error('[approver-nudge] tick failed:', err);
      await trackError(err, undefined, { source: 'approver-nudge-tick' });
    }
  };

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[approver-nudge] tick error:', err));
  }, NUDGE_INTERVAL_MS);

  // Don't immediately fire on startup — wait one tick so a fresh
  // deploy doesn't double-DM if the previous instance just nudged.
  console.log('[approver-nudge] scheduler started (1h interval, 48h threshold)');
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

  const summary = request.deliverable_summary
    ? request.deliverable_summary.slice(0, 100)
    : 'a marketing request';

  const text =
    `Reminder: <@${request.requester_user_id}> is waiting on your approval for "${summary}".` +
    (permalink ? ` Approve here: <${permalink}>` : '');

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
