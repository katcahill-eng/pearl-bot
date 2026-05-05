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
const CALENDAR_RESURFACE_STATUSES = new Set(['Under Review', 'Stuck']);

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
 * Format a lifecycle event as a one-line message for the originating
 * channel thread.
 */
export function formatThreadReply(event: LifecycleEvent): string {
  switch (event.kind) {
    case 'status_change': {
      const arrow = event.oldStatus
        ? `*${event.oldStatus}* → *${event.newStatus}*`
        : `*${event.newStatus}*`;
      const owner = event.ownerName ? ` · ${event.ownerName} assigned` : '';
      const base = `Status: ${arrow}${owner}`;
      if (CALENDAR_RESURFACE_STATUSES.has(event.newStatus) && MARKETING_CALENDAR_URL) {
        return `${base}\nIf you'd like to walk through it with marketing: <${MARKETING_CALENDAR_URL}|Schedule a call>`;
      }
      return base;
    }
    case 'deliverable_attached':
      return `Deliverable ready: <${event.fileUrl}|${event.fileName}>`;
    case 'due_date_changed':
      return `Due date moved to *${event.newDate}*`;
    case 'owner_changed':
      return `Reassigned to *${event.ownerName}*`;
    case 'additional_divisions_changed':
      return `Cross-division impact updated: ${event.divisions.join(', ')}`;
  }
}

/**
 * Format the same event as a shorter mirror reply for the alerts
 * channel — marketing's coordination thread doesn't need the calendar
 * line or other requester-facing framing.
 */
export function formatAlertMirror(event: LifecycleEvent): string {
  switch (event.kind) {
    case 'status_change':
      return `Status → ${event.newStatus}${event.ownerName ? ` (${event.ownerName} assigned)` : ''}`;
    case 'deliverable_attached':
      return `Deliverable: <${event.fileUrl}|${event.fileName}>`;
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
  try {
    await client.chat.postMessage({
      channel: record.originating_channel_id,
      thread_ts: record.originating_thread_ts,
      text: formatThreadReply(event),
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
  try {
    await client.chat.postMessage({
      channel: record.alert_channel_id,
      thread_ts: record.alert_message_ts,
      text: formatAlertMirror(event),
    });
  } catch (err) {
    console.error('[lifecycle] alert mirror failed:', err);
    // Don't escalate — the originating reply already succeeded.
  }
}
