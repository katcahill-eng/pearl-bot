/**
 * Sage v2 view-submission handler.
 *
 * Receives the modal submission from the Open request form button
 * (US-009). Creates a Monday item with all v2 columns populated, plus
 * sub-items for any checked director-brain recommendations. Persists a
 * request_records row so US-012 (thread confirmation), US-013 (alerts
 * notification), US-016 (lifecycle replies), and US-022 (post-
 * submission follow-ups) can all look up the request later.
 *
 * Per PRD US-005, the modal's private_metadata carries channelId and
 * threadTs. The submitter is body.user.id; the requester defaults to
 * the submitter unless the modal's "Requesting for" field is filled.
 */

import type { App } from '@slack/bolt';
import { CALLBACK_ID } from '../lib/modals/request-modal';
import { divisionForChannel, type Division } from '../lib/division-lookup';
import {
  resolveMondayUserId,
  resolveMondayUserIds,
  getSlackDisplayName,
} from '../lib/slack-monday-bridge';
import {
  createV2RequestItem,
  createV2SubItem,
  buildMondayUrl,
} from '../lib/monday';
import { insertRequestRecord } from '../lib/db';
import { logRequestEvent } from '../lib/event-log';
import { trackError } from '../lib/error-tracker';
import { matchRecommendations, type Recommendation } from '../lib/director-rules';

interface ParsedModalState {
  requestType: string | null;
  deliverable: string;
  audience: string | null;
  eventOrProject: string | null;
  deadline: string | null;
  approverSlackIds: string[];
  additionalDivisions: Division[];
  requestingForSlackId: string | null;
  recommendationNames: string[];
}

export interface ModalMetadata {
  channelId: string;
  threadTs: string;
}

/**
 * Extract field values from the modal's view.state.values payload into
 * a typed ParsedModalState. Pure function — no side effects.
 */
export function parseModalState(viewStateValues: any): ParsedModalState {
  const v = viewStateValues ?? {};

  const requestType =
    v.request_type?.value?.selected_option?.value ?? null;

  const deliverable =
    v.deliverable?.value?.value ?? '';

  const audience =
    v.audience?.value?.value ?? null;

  const eventOrProject =
    v.event_or_project?.value?.value ?? null;

  const deadline =
    v.deadline?.value?.selected_date ?? null;

  const approverSlackIds: string[] =
    v.approvals?.value?.selected_users ?? [];

  const additionalDivisions: Division[] =
    (v.additional_divisions?.value?.selected_options ?? []).map(
      (o: any) => o.value as Division,
    );

  const requestingForSlackId =
    v.requesting_for?.value?.selected_user ?? null;

  const recommendationNames: string[] =
    (v.recommendations?.value?.selected_options ?? []).map(
      (o: any) => o.value as string,
    );

  return {
    requestType,
    deliverable,
    audience,
    eventOrProject,
    deadline,
    approverSlackIds,
    additionalDivisions,
    requestingForSlackId,
    recommendationNames,
  };
}

/**
 * Derive a short item name (used as the Monday Project Title) from the
 * deliverable text. First sentence or first ~80 chars, trimmed.
 */
export function deriveItemName(deliverable: string): string {
  const cleaned = deliverable.trim();
  if (!cleaned) return 'New marketing request';
  const firstSentence = cleaned.split(/[.!?\n]/)[0] ?? cleaned;
  return firstSentence.slice(0, 80).trim() || 'New marketing request';
}

export function registerViewSubmissionHandler(app: App): void {
  app.view(CALLBACK_ID, async ({ ack, body, view, client }) => {
    await ack();

    const submitterSlackId = body.user.id;

    let metadata: ModalMetadata;
    try {
      metadata = JSON.parse(view.private_metadata) as ModalMetadata;
    } catch (err) {
      console.error('[view-submission] private_metadata parse failed:', err);
      await trackError(err, undefined, { source: 'view-submission' });
      return;
    }

    const division = divisionForChannel(metadata.channelId);
    if (!division) {
      console.error(
        `[view-submission] No division for channel ${metadata.channelId}`,
      );
      await trackError(
        new Error('Division lookup failed at submission'),
        undefined,
        { source: 'view-submission', channel: metadata.channelId },
      );
      return;
    }

    const state = parseModalState(view.state.values);

    try {
      // Determine the requester: proxy submission overrides submitter.
      const requesterSlackId = state.requestingForSlackId ?? submitterSlackId;

      // Resolve Slack → Monday users in parallel.
      const [requesterMondayId, approverMondayIds, requestingForMondayId] =
        await Promise.all([
          resolveMondayUserId(requesterSlackId, client),
          resolveMondayUserIds(state.approverSlackIds, client),
          state.requestingForSlackId
            ? resolveMondayUserId(submitterSlackId, client)
            : Promise.resolve(null),
        ]);

      if (!requesterMondayId) {
        // FR-6: items without a resolvable requester are rejected.
        await client.chat.postMessage({
          channel: metadata.channelId,
          thread_ts: metadata.threadTs,
          text:
            "I couldn't find your Monday account from your Slack profile — your Pearl email needs to match a Monday user. " +
            "Ping marketing to get your Monday account set up, then try again.",
        });
        return;
      }

      // Recompute recommendations from the parsed fields so we can
      // resolve the deliverable text for any checked recommendation.
      const allRecommendations = matchRecommendations({
        requestType: state.requestType,
        deliverable: state.deliverable,
        eventOrProject: state.eventOrProject,
      });
      const checkedRecommendations: Recommendation[] = allRecommendations.filter(
        (r) => state.recommendationNames.includes(r.name),
      );

      const requesterName = await getSlackDisplayName(requesterSlackId, client);
      const itemName = deriveItemName(state.deliverable);

      const mondayItem = await createV2RequestItem({
        name: itemName,
        division,
        submitterSlackUserId: submitterSlackId,
        requesterMondayUserId: requesterMondayId,
        approverMondayUserIds: approverMondayIds,
        requestingForMondayUserId: requestingForMondayId,
        additionalDivisions: state.additionalDivisions,
        deliverableType: requestTypeToDeliverableLabel(state.requestType),
        deliverable: state.deliverable,
        audience: state.audience,
        contextBackground: state.eventOrProject ?? null,
        dueDate: state.deadline,
        legacyApproversText: null, // set in US-012 once we have approver names
        legacyRequesterText: `${requesterName} — ${division}`,
      });

      // Create sub-items for checked recommendations.
      for (const rec of checkedRecommendations) {
        try {
          await createV2SubItem({
            parentItemId: mondayItem.id,
            name: rec.name,
            recommendation: rec,
          });
        } catch (subErr) {
          // Don't fail the whole submission for a sub-item error;
          // log and continue.
          console.error(`[view-submission] sub-item ${rec.name} failed:`, subErr);
          await trackError(subErr, undefined, {
            source: 'view-submission-subitem',
            recommendation: rec.name,
          });
        }
      }

      // Persist the v2 request record so future stories can look it up.
      const record = await insertRequestRecord({
        monday_item_id: mondayItem.id,
        originating_channel_id: metadata.channelId,
        originating_thread_ts: metadata.threadTs,
        requester_user_id: requesterSlackId,
        requesting_for_user_id: state.requestingForSlackId,
        approver_user_ids: state.approverSlackIds,
        division,
        request_type: state.requestType,
        deliverable_summary: state.deliverable.slice(0, 200),
      });

      await logRequestEvent({
        eventType: 'modal_submitted',
        userId: submitterSlackId,
        channelId: metadata.channelId,
        intent: 'work_request',
        parsedFields: state,
        recommendationsAccepted: checkedRecommendations,
        mondayItemId: mondayItem.id,
      });

      // US-012: customer-service confirmation reply on the originating
      // thread. US-013: one-line notification in the alerts channel.
      // Both are implemented in subsequent stories — invoked here so
      // the v2 happy path is end-to-end.
      const { postSubmissionReplies } = await import('./submission-replies');
      await postSubmissionReplies({
        client,
        record,
        mondayUrl: mondayItem.url,
        approverSlackIds: state.approverSlackIds,
        deliverableSummary: state.deliverable,
        deadline: state.deadline,
        requesterName,
        division,
        requestTypeLabel: requestTypeToDeliverableLabel(state.requestType) ?? state.requestType ?? 'Request',
      });
    } catch (err) {
      console.error('[view-submission] Failed:', err);
      await trackError(err, undefined, {
        source: 'view-submission',
        channel: metadata.channelId,
      });
      try {
        await client.chat.postMessage({
          channel: metadata.channelId,
          thread_ts: metadata.threadTs,
          text:
            "Something went wrong creating your request — marketing will see this in the error log. " +
            "You can try again, and if it keeps failing, ping someone from the marketing team directly.",
        });
      } catch {
        // best-effort — already in the error log
      }
    }
  });
}

/**
 * Map a v2 requestType (from the modal's static_select) to a label
 * that matches the existing status_16 "Type of Deliverable" column on
 * the 00. board.
 */
export function requestTypeToDeliverableLabel(
  requestType: string | null,
): string | null {
  if (!requestType) return null;
  const map: Record<string, string> = {
    webinar: 'Webinar',
    email: 'Emails',
    graphic: 'Social Media',
    blog: 'B2B Blog Post',
    presentation: 'Presentation',
    press_release: 'Press Release',
    event: 'Event',
    product_launch: 'Press Release',
    landing_page: 'Landing Page',
    social_media: 'Social Media',
    document: 'Document',
    research: 'Research',
    other: 'Other (Describe below)',
  };
  return map[requestType] ?? null;
}
