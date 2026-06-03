/**
 * Sage v2 lifecycle reply composer.
 *
 * Single source of truth for the copy + posting logic when a Monday
 * change needs to surface back to Slack. Called by:
 *   - Monday webhook receiver (US-017)
 *   - Monday polling fallback   (US-018)
 *
 * Per PRD US-019/020/021:
 *   - Posts a reply on the originating channel thread (the requester's
 *     thread) with a one-line summary of what changed.
 *   - Mirror-posts a one-line summary as a reply on the alert message
 *     in #mktg_incoming_requests so marketing's coordination thread
 *     stays current.
 *   - Re-surfaces the calendar link only when status moves to
 *     'Under Review' or 'Stuck' — not on every transition.
 */

import type { WebClient } from '@slack/web-api';
import {
  getRequestByMondayItemId,
  setRequestStatus,
  type RequestRecord,
} from './db';
import { logRequestEvent } from './event-log';
import { trackError } from './error-tracker';

const MARKETING_CALENDAR_URL = process.env.MARKETING_LEAD_CALENDAR_URL;

/**
 * Status transitions that produce SILENT lifecycle replies on the
 * requester's thread. These are internal-only marketing tracking
 * states; surfacing them to the requester would be confusing or
 * worse (e.g., "Declined" should always be a conversation, not a
 * Sage announcement).
 */
const SILENT_STATUSES = new Set(['Stuck', 'Declined']);

export type LifecycleEvent =
  | { kind: 'status_change'; oldStatus: string | null; newStatus: string; ownerName?: string | null }
  | { kind: 'deliverable_attached'; fileUrl: string; fileName: string }
  | { kind: 'due_date_changed'; newDate: string }
  | { kind: 'owner_changed'; ownerName: string }
  | { kind: 'additional_divisions_changed'; divisions: string[] };

export interface LifecycleContext {
  client: WebClient;
  /** Monday item id for the request that changed. */
  mondayItemId: string;
  event: LifecycleEvent;
}

const dedupCache = new Map<string, number>(); // key → last-emitted timestamp ms
const DEDUP_WINDOW_MS = 30_000;

function dedupKey(mondayItemId: string, event: LifecycleEvent): string {
  switch (event.kind) {
    case 'status_change':
      return `${mondayItemId}|status|${event.oldStatus}|${event.newStatus}`;
    case 'deliverable_attached':
      return `${mondayItemId}|deliverable|${event.fileUrl}`;
    case 'due_date_changed':
      return `${mondayItemId}|due|${event.newDate}`;
    case 'owner_changed':
      return `${mondayItemId}|owner|${event.ownerName}`;
    case 'additional_divisions_changed':
      return `${mondayItemId}|divisions|${event.divisions.join(',')}`;
  }
}

export function _resetDedupForTesting(): void {
  dedupCache.clear();
}

/**
 * Format a lifecycle event as a Slack message for the originating
 * channel thread. Returns null for events that shouldn't surface to
 * the requester.
 *
 * The mapping is intentional and copy-blessed by Kat 2026-05-06:
 *   New → Working on it          "Marketing has accepted this..."
 *   → More information needed    "More information needed..." + calendar link
 *   → Pending review             "Draft ready for review..." (deliverable URL is
 *                                added by the caller; not in this string)
 *   → Stuck / Declined           silent (internal-only)
 *   → Completed/Live             "All set — approved and complete."
 *   Pending review → Working on it (after request_changes) — silent
 *     (the request_changes button click already posted its own message)
 *   Other column changes (owner, due date, divisions) — silent
 *     (low-signal noise; the requester doesn't need a ping for these)
 */
export function formatThreadReply(
  event: LifecycleEvent,
  requesterUserId?: string,
): string | null {
  // @-tag the requester so Slack treats lifecycle messages as mentions
  // — that way the channel highlights and a number badge appears in
  // the sidebar. Without this, bot replies in your own thread don't
  // bubble up the way other channel messages do.
  const tag = requesterUserId ? `<@${requesterUserId}> — ` : '';

  switch (event.kind) {
    case 'status_change': {
      const newStatus = event.newStatus;
      if (SILENT_STATUSES.has(newStatus)) return null;

      if (newStatus === 'Working on it' && event.oldStatus === 'New') {
        return `${tag}marketing has accepted this request and started work. Status updates will post here as it progresses.`;
      }
      if (newStatus === 'Working on it') {
        // Working on it from any other state (e.g. Pending review when
        // changes were requested) — silent. The change-request flow
        // already posted its own message.
        return null;
      }
      if (newStatus === 'More information needed') {
        if (MARKETING_CALENDAR_URL) {
          return (
            `${tag}marketing has a few questions before they can dig in. ` +
            `Let's grab 30 minutes to talk it through: <${MARKETING_CALENDAR_URL}|schedule a call>.`
          );
        }
        return `${tag}marketing has a few questions before they can dig in. They'll follow up here with what they need.`;
      }
      if (newStatus === 'Pending review') {
        // Caller composes the full message including deliverable URL
        // and approver tags + buttons. Returning null here so the
        // composer's special pending-review branch handles it.
        return null;
      }
      if (newStatus === 'Completed/Live') {
        return (
          `${tag}thanks so much for working with marketing on this — we're marking this request as complete. ` +
          `If you need help on a future project, @Sage in a new thread and we'll jump right in.`
        );
      }
      // Any other status change is silent.
      return null;
    }
    case 'deliverable_attached':
      // Files attached during work-in-progress are NOT a signal to
      // the requester (per Kat 2026-05-06). Marketing attaches WIP
      // files for organization. The deliverable surfaces only when
      // status flips to Pending review and the Deliverable URL column
      // is populated.
      return null;
    case 'due_date_changed':
    case 'owner_changed':
    case 'additional_divisions_changed':
      // Low-signal column changes — keep the thread quiet.
      return null;
  }
}

/**
 * Format the same event as a shorter mirror reply for the alerts
 * channel. Marketing IS the audience here, so we surface status
 * changes that would be silent on the requester thread (Stuck,
 * Declined) — these are exactly the moments marketing wants to see.
 */
const ALERT_MIRROR_SILENT = new Set(['Under Review', 'Moved to 02 board']);

export function formatAlertMirror(event: LifecycleEvent): string | null {
  switch (event.kind) {
    case 'status_change': {
      if (ALERT_MIRROR_SILENT.has(event.newStatus)) return null;
      // "Working on it" from non-New states is an internal revert — silent.
      if (event.newStatus === 'Working on it' && event.oldStatus !== 'New') return null;
      return `Status → ${event.newStatus}${event.ownerName ? ` (${event.ownerName} assigned)` : ''}`;
    }
    case 'deliverable_attached':
      // Marketing attached a WIP file — they don't need an alert
      // mirror about their own action.
      return null;
    case 'due_date_changed':
      return `Due → ${event.newDate}`;
    case 'owner_changed':
      return `Owner → ${event.ownerName}`;
    case 'additional_divisions_changed':
      return `Divisions → ${event.divisions.join(', ')}`;
  }
}

/**
 * Compose and post the lifecycle reply on both the originating thread
 * and the alert thread (if the request has one).
 */
export async function composeAndPostLifecycleReply(
  ctx: LifecycleContext,
): Promise<void> {
  const { client, mondayItemId, event } = ctx;

  // De-dup webhook retries / poller doubles.
  const key = dedupKey(mondayItemId, event);
  const last = dedupCache.get(key);
  if (last && Date.now() - last < DEDUP_WINDOW_MS) return;
  dedupCache.set(key, Date.now());

  const record = await getRequestByMondayItemId(mondayItemId);
  if (!record) {
    // Item not tracked by Sage — silently skip.
    return;
  }

  // Persist status changes to request_records so US-022 / US-023
  // can read the current status without re-querying Monday.
  if (event.kind === 'status_change') {
    try {
      await setRequestStatus(record.id, event.newStatus);
    } catch (err) {
      console.error('[lifecycle] setRequestStatus failed:', err);
    }
  }

  // Originating-thread reply (US-019 + US-021 calendar re-surface).
  await postOriginatingReply(record, event, client);

  // Alert-thread mirror (US-020).
  if (record.alert_channel_id && record.alert_message_ts) {
    await postAlertMirror(record, event, client);
  }

  await logRequestEvent({
    eventType: 'lifecycle_reply_posted',
    userId: record.requester_user_id,
    channelId: record.originating_channel_id,
    mondayItemId,
  });
}

async function postOriginatingReply(
  record: RequestRecord,
  event: LifecycleEvent,
  client: WebClient,
): Promise<void> {
  // Special case: Pending review needs the deliverable URL +
  // approver tags + Approve / Request changes buttons. Composed
  // separately because it's a multi-block message, not a single line.
  if (event.kind === 'status_change' && event.newStatus === 'Pending review') {
    await postPendingReviewMessage(record, client);
    return;
  }

  const text = formatThreadReply(event, record.requester_user_id);
  if (!text) return; // Silent event — nothing to post.

  try {
    await client.chat.postMessage({
      channel: record.originating_channel_id,
      thread_ts: record.originating_thread_ts,
      text,
    });
  } catch (err) {
    console.error('[lifecycle] thread reply failed:', err);
    await trackError(err, undefined, {
      source: 'lifecycle-thread-reply',
      monday: record.monday_item_id,
    });
  }
}

async function postAlertMirror(
  record: RequestRecord,
  event: LifecycleEvent,
  client: WebClient,
): Promise<void> {
  if (!record.alert_channel_id || !record.alert_message_ts) return;
  const text = formatAlertMirror(event);
  if (!text) return;
  try {
    await client.chat.postMessage({
      channel: record.alert_channel_id,
      thread_ts: record.alert_message_ts,
      text,
    });
  } catch (err) {
    console.error('[lifecycle] alert mirror failed:', err);
    // Don't escalate — the originating reply already succeeded.
  }
}

/**
 * Post the Pending-review message: tags approvers, includes the
 * deliverable URL (read from Monday's Deliverable URL column at
 * trigger time), and renders Approve / Request changes buttons.
 *
 * This is the moment Stage 2 approval kicks in (per Kat's design):
 * marketing has produced a draft and explicitly flipped status to
 * Pending review. Approvers act here, not at submission.
 */
async function postPendingReviewMessage(
  record: RequestRecord,
  client: WebClient,
): Promise<void> {
  // Look up the Deliverable URL on the Monday item.
  let deliverableUrl: string | null = null;
  try {
    const { mondayApi } = await import('./monday');
    const data = await mondayApi<{
      items: { column_values: { id: string; text: string; value: string | null }[] }[];
    }>(
      `query ($itemId: ID!) {
        items(ids: [$itemId]) {
          column_values(ids: ["link_mm33bes6"]) {
            id
            text
            value
          }
        }
      }`,
      { itemId: record.monday_item_id },
    );
    const link = data.items?.[0]?.column_values?.[0];
    if (link?.value) {
      try {
        const parsed = JSON.parse(link.value);
        deliverableUrl = parsed.url ?? null;
      } catch {
        // value not JSON — fall back to text
      }
    }
    if (!deliverableUrl && link?.text) {
      deliverableUrl = link.text;
    }
  } catch (err) {
    console.error('[lifecycle] Failed to fetch Deliverable URL:', err);
  }

  const approverMentions = record.approver_user_ids.length > 0
    ? record.approver_user_ids.map((id) => `<@${id}>`).join(' ')
    : '';

  // Tag the requester too so their channel sidebar highlights.
  const requesterTag = `<@${record.requester_user_id}>`;

  const { buildMondayUrl } = await import('./monday');
  const mondayItemUrl = buildMondayUrl(record.monday_item_id);
  const deliverableLine = deliverableUrl
    ? `${requesterTag} — draft ready for review: <${deliverableUrl}>`
    : `${requesterTag} — draft ready for review. <${mondayItemUrl}|Open your request in Monday> and check the Deliverables column for the link.`;

  const approverLine = approverMentions
    ? `\n${approverMentions} — please review when you have a moment.`
    : '';

  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${deliverableLine}${approverLine}` },
    },
  ];

  if (record.approver_user_ids.length > 0) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'sage_v2_approve_request',
          text: { type: 'plain_text', text: '✅ Approve' },
          style: 'primary',
          value: String(record.id),
        },
        {
          type: 'button',
          action_id: 'sage_v2_request_changes',
          text: { type: 'plain_text', text: '✏️ Request changes' },
          value: String(record.id),
        },
      ],
    });
  }

  try {
    await client.chat.postMessage({
      channel: record.originating_channel_id,
      thread_ts: record.originating_thread_ts,
      text: `Draft ready for review.`,
      blocks,
    });
  } catch (err) {
    console.error('[lifecycle] pending-review post failed:', err);
    await trackError(err, undefined, {
      source: 'lifecycle-pending-review',
      monday: record.monday_item_id,
    });
  }
}
