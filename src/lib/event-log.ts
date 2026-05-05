/**
 * Non-throwing request-events logger for Sage v2.
 *
 * Per PRD FR-9, event logging must never block the main request flow.
 * Failures are swallowed and reported to error-tracker.ts; callers do
 * not catch.
 *
 * Use this helper for all lifecycle events (modal_opened, modal_submitted,
 * lifecycle_reply_posted, etc.) — see PRD US-009 for the canonical event
 * vocabulary.
 */

import { insertRequestEvent } from './db';
import { trackError } from './error-tracker';

export type RequestEventType =
  | 'modal_opened'
  | 'modal_submitted'
  | 'modal_cancelled'
  | 'clarifying_question_asked'
  | 'clarifying_question_answered'
  | 'alert_posted'
  | 'lifecycle_reply_posted'
  | 'approver_nudged_dm'
  | 'calendar_link_offered'
  | 'follow_up_received'
  | 'request_approved'
  | 'changes_requested'
  | 'monday_event_received'
  | 'poller_tick';

export interface RequestEvent {
  userId?: string | null;
  channelId?: string | null;
  channelRole?: string | null;
  eventType: RequestEventType;
  intent?: string | null;
  parsedFields?: unknown;
  recommendationsOffered?: unknown;
  recommendationsAccepted?: unknown;
  mondayItemId?: string | null;
}

/**
 * Insert a request event. Never throws — DB failures are reported via
 * trackError but the caller's main flow proceeds.
 */
export async function logRequestEvent(event: RequestEvent): Promise<void> {
  try {
    await insertRequestEvent({
      user_id: event.userId ?? null,
      channel_id: event.channelId ?? null,
      channel_role: event.channelRole ?? null,
      event_type: event.eventType,
      intent: event.intent ?? null,
      parsed_fields_json: event.parsedFields ?? null,
      recommendations_offered_json: event.recommendationsOffered ?? null,
      recommendations_accepted_json: event.recommendationsAccepted ?? null,
      monday_item_id: event.mondayItemId ?? null,
    });
  } catch (err) {
    // Swallow — observability failures must not block the main request flow.
    // The error itself goes to the error tracker so we can see what's wrong
    // without interrupting the user.
    try {
      await trackError(err, undefined, {
        source: 'event-log',
        eventType: event.eventType,
      });
    } catch {
      // Last-resort fallback if even error tracking fails.
      console.error('[event-log] insert failed AND error-tracker failed:', err);
    }
  }
}
