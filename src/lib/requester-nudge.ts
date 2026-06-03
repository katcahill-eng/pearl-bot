/**
 * Sage v2 "More information needed" requester nudge scheduler.
 *
 * When a Monday item stays in "More information needed" status and the
 * requester hasn't responded, Sage posts a thread reply in the
 * originating channel at 24, 48, and 72 *business* hours (weekends
 * excluded). Each tier fires at most once per request.
 *
 * A triage mirror is posted to the alert channel on each nudge so
 * marketing knows whether to follow up manually.
 */

import type { WebClient } from '@slack/web-api';
import { getMoreInfoNudges, recordRequesterNudge } from './db';
import { trackError } from './error-tracker';
import { logRequestEvent } from './event-log';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

const REQUESTER_COPY: Record<1 | 2 | 3, (tag: string, calendarUrl: string | undefined) => string> = {
  1: (tag, cal) =>
    `${tag} just checking in — marketing still needs a bit more info to move forward. ` +
    (cal ? `Schedule a quick call here if that's easier: <${cal}|book time>. ` : '') +
    `Reply in this thread when you have a moment.`,
  2: (tag, cal) =>
    `${tag} following up again — marketing is waiting on your reply before they can continue. ` +
    (cal ? `You can also <${cal}|book a quick call> if that's easier. ` : '') +
    `Reply here when you're ready.`,
  3: (tag, _cal) =>
    `${tag} this is our last automatic reminder. Marketing hasn't received the information they need ` +
    `and may need to put this request on hold. Reply here if you'd like to continue.`,
};

const TRIAGE_COPY: Record<1 | 2 | 3, (requesterUserId: string) => string> = {
  1: (uid) => `Requester nudge 1/3 sent — <@${uid}> hasn't replied after 24 business hours.`,
  2: (uid) => `Requester nudge 2/3 sent — <@${uid}> hasn't replied after 48 business hours.`,
  3: (uid) => `Requester nudge 3/3 sent — <@${uid}> hasn't replied after 72 business hours. Manual follow-up may be needed.`,
};

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startRequesterNudgeScheduler(client: WebClient): void {
  const tick = async () => {
    try {
      const pending = await getMoreInfoNudges();
      let sent = 0;
      for (const { request, nudgeLevel } of pending) {
        try {
          const tag = `<@${request.requester_user_id}>`;
          const calendarUrl = process.env.MARKETING_LEAD_CALENDAR_URL;

          // Thread reply to requester
          await client.chat.postMessage({
            channel: request.originating_channel_id,
            thread_ts: request.originating_thread_ts,
            text: REQUESTER_COPY[nudgeLevel](tag, calendarUrl),
          });

          // Triage mirror (no reply_broadcast — stays in thread)
          if (request.alert_channel_id && request.alert_message_ts) {
            try {
              await client.chat.postMessage({
                channel: request.alert_channel_id,
                thread_ts: request.alert_message_ts,
                text: TRIAGE_COPY[nudgeLevel](request.requester_user_id),
              });
            } catch (err) {
              console.error('[requester-nudge] triage mirror failed:', err);
            }
          }

          await recordRequesterNudge(request.id, nudgeLevel);
          await logRequestEvent({
            eventType: 'requester_nudged',
            userId: request.requester_user_id,
            channelId: request.originating_channel_id,
            mondayItemId: request.monday_item_id,
          });
          sent++;
        } catch (err) {
          console.error('[requester-nudge] nudge failed for request', request.id, err);
          await trackError(err, undefined, {
            source: 'requester-nudge',
            request: request.id.toString(),
          });
        }
      }
      if (sent > 0) console.log(`[requester-nudge] Sent ${sent} nudge(s)`);
    } catch (err) {
      console.error('[requester-nudge] tick failed:', err);
      await trackError(err, undefined, { source: 'requester-nudge-tick' });
    }
  };

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[requester-nudge] tick error:', err));
  }, CHECK_INTERVAL_MS);

  console.log('[requester-nudge] scheduler started (1h interval, 24/48/72h business-hour thresholds)');
}

export function stopRequesterNudgeScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
