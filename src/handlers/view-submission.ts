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
  draftSource: string | null;
  deadline: string | null;
  liveDate: string | null;
  approverSlackIds: string[];
  additionalDivisions: Division[];
  requestingForSlackId: string | null;
  recommendationNames: string[];
}

/**
 * Pearl marketing's minimum end-to-end timeline:
 *   1 week to draft + 1 week to review = 14 days from request to in-hand.
 * If the in-hand date (deadline) — or live date as fallback — is closer
 * than that, the request is flagged as a rush.
 */
export const MIN_TURNAROUND_DAYS = 14;

export interface RushAssessment {
  isRush: boolean;
  daysUntilInHand: number | null;
  effectiveDate: string | null; // the date we measured against (deadline or live date)
}

/**
 * Pure function — given a deadline / live date / today's date, decide
 * whether the timeline is shorter than Pearl's minimum 2-week build +
 * review cycle. Used by view-submission to flag rush requests.
 */
export function assessRush(
  deadline: string | null,
  liveDate: string | null,
  today: Date = new Date(),
): RushAssessment {
  const target = deadline ?? liveDate;
  if (!target) {
    return { isRush: false, daysUntilInHand: null, effectiveDate: null };
  }
  // Compare calendar dates in Eastern time so day counts match what
  // Pearl staff see on their clocks, not the UTC server clock.
  const todayETStr = today.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [ty, tm, td] = todayETStr.split('-').map(Number);
  const [gy, gm, gd] = target.split('-').map(Number);
  if (!gy || !gm || !gd) {
    return { isRush: false, daysUntilInHand: null, effectiveDate: null };
  }
  const todayMidnight = new Date(ty, tm - 1, td);
  const targetMidnight = new Date(gy, gm - 1, gd);
  const ms = targetMidnight.getTime() - todayMidnight.getTime();
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  return {
    isRush: days < MIN_TURNAROUND_DAYS,
    daysUntilInHand: days,
    effectiveDate: target,
  };
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
    v.request_type?.sage_v2_request_type_change?.selected_option?.value ??
    v.request_type?.value?.selected_option?.value ?? // legacy fallback
    null;

  const deliverable =
    v.deliverable?.value?.value ?? '';

  const audience =
    v.audience?.value?.value ?? null;

  const eventOrProject =
    v.event_or_project?.value?.value ?? null;

  const draftSource =
    v.draft_source?.value?.value ?? null;

  const deadline =
    v.deadline?.sage_v2_deadline_change?.selected_date ??
    v.deadline?.value?.selected_date ?? // legacy fallback
    null;

  const liveDate =
    v.live_date?.sage_v2_live_date_change?.selected_date ??
    v.live_date?.value?.selected_date ?? // legacy fallback
    null;

  const approverSlackIds: string[] =
    v.approvals?.value?.selected_users ?? [];

  const additionalDivisions: Division[] =
    (v.additional_divisions?.value?.selected_options ?? [])
      .map((o: any) => o.value as string)
      .filter((v: string) => v !== '__NONE__') as Division[];

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
    draftSource,
    deadline,
    liveDate,
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
    // Parse the modal state up-front so we can run server-side
    // validation BEFORE ack'ing the submission. This is the backstop
    // for cases where Slack's required-field validation slips —
    // particularly the draft_source field which keeps showing as
    // optional in some flows even when policy applies.
    const state = parseModalState(view.state.values);

    const policyTypes = new Set([
      'email',
      'presentation',
      'webinar',
      'press_release',
      'blog',
      'landing_page',
      'social_media',
      'document',
    ]);

    const draftRequired = state.requestType ? policyTypes.has(state.requestType) : false;
    const draftMissing =
      draftRequired && !(state.draftSource && state.draftSource.trim());

    if (draftMissing) {
      // ack with response_action: 'errors' keeps the form open with
      // an inline error on the draft_source block.
      await ack({
        response_action: 'errors',
        errors: {
          draft_source:
            "Please paste a link to your draft. If you don't have one yet, schedule a call to discuss (link below).",
        },
      });
      return;
    }

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
      // Don't bail silently — let the requester know we received the
      // submission but can't process it from this channel.
      try {
        await client.chat.postMessage({
          channel: metadata.channelId,
          thread_ts: metadata.threadTs,
          text:
            "I got your form, but this channel isn't fully set up for marketing requests yet. " +
            "Please file from your division's `#mktg_{division}_requests` channel.",
        });
      } catch (notifyErr) {
        console.error('[view-submission] failed to post fallback message:', notifyErr);
      }
      return;
    }

    // state is parsed above before ack — reusing here.

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

      // Capture the Slack thread permalink so marketing can jump back
      // to the original request from Monday.
      let threadPermalink: string | null = null;
      try {
        const result = await client.chat.getPermalink({
          channel: metadata.channelId,
          message_ts: metadata.threadTs,
        });
        threadPermalink = result.permalink ?? null;
      } catch (err) {
        console.error('[view-submission] getPermalink failed (non-critical):', err);
      }

      // Compose Context & Background: prepend Event/project line if set,
      // then the requester's full description of what they need.
      const contextBackground = state.eventOrProject
        ? `Event/project: ${state.eventOrProject}\n\n${state.deliverable}`
        : state.deliverable;

      // Rush detection — computed before item creation so the Rush
      // status column gets set in the same write as everything else.
      const rush = assessRush(state.deadline, state.liveDate);

      const mondayItem = await createV2RequestItem({
        name: itemName,
        division,
        submitterSlackUserId: submitterSlackId,
        requesterMondayUserId: requesterMondayId,
        approverMondayUserIds: approverMondayIds,
        requestingForMondayUserId: requestingForMondayId,
        additionalDivisions: state.additionalDivisions,
        deliverableType: requestTypeToDeliverableLabel(state.requestType),
        // Monday's Deliverable(s) long_text column is no longer written —
        // the Type of Deliverable status column captures the format,
        // and the full description lives in Context & Background.
        deliverable: '',
        audience: state.audience,
        contextBackground,
        dueDate: state.deadline,
        supportingLinks: state.draftSource ?? null,
        submissionLink: threadPermalink,
        legacyApproversText: null, // set in US-012 once we have approver names
        legacyRequesterText: `${requesterName} — ${division}`,
        rush: rush.isRush,
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

      // Rush bump on the legacy Priority column — kept for analytics
      // continuity; the Rush status column (set above in createV2RequestItem)
      // is the source of truth going forward.
      if (rush.isRush) {
        try {
          const { updateMondayItemColumns } = await import('../lib/monday');
          await updateMondayItemColumns(mondayItem.id, {
            status_1: { label: 'High' },
          });
        } catch (priorityErr) {
          console.error('[view-submission] priority bump failed:', priorityErr);
        }
      }

      // Customer-service confirmation reply + alerts notification.
      const { postSubmissionReplies } = await import('./submission-replies');
      await postSubmissionReplies({
        client,
        record,
        mondayUrl: mondayItem.url,
        approverSlackIds: state.approverSlackIds,
        deliverableSummary: state.deliverable,
        deadline: state.deadline,
        liveDate: state.liveDate,
        rush,
        requesterName,
        division,
        requestType: state.requestType,
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
