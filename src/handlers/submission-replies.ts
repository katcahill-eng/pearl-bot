/**
 * Sage v2 post-submission Slack messages.
 *
 * After view-submission (US-011) creates the Monday item, two Slack
 * messages go out:
 *
 *   US-012: customer-service-style confirmation reply on the
 *           originating channel thread, with calendar link, next-step
 *           guidance, and Approve / Request changes buttons for the
 *           tagged approvers.
 *   US-013: one-line top-level notification in the alerts channel
 *           (#mktg_incoming_requests) so marketing can see new
 *           requests landing.
 *
 * Both are wrapped here in postSubmissionReplies. On success, the
 * alert message's channel + ts is persisted on the request record so
 * lifecycle replies (US-019/US-020) can mirror to the alert thread.
 */

import type { WebClient } from '@slack/web-api';
import { findChannelsByRole } from '../lib/division-lookup';
import {
  updateRequestAlertInfo,
  type RequestRecord,
} from '../lib/db';
import { logRequestEvent } from '../lib/event-log';
import { trackError } from '../lib/error-tracker';

const MARKETING_CALENDAR_URL = process.env.MARKETING_LEAD_CALENDAR_URL;

export const APPROVE_ACTION_ID = 'sage_v2_approve_request';
export const REQUEST_CHANGES_ACTION_ID = 'sage_v2_request_changes';

interface PostSubmissionRepliesInput {
  client: WebClient;
  record: RequestRecord;
  mondayUrl: string;
  approverSlackIds: string[];
  deliverableSummary: string;
  deadline: string | null;
  liveDate: string | null;
  rush: { isRush: boolean; daysUntilInHand: number | null; effectiveDate: string | null };
  requesterName: string;
  division: string;
  requestType: string | null;
  requestTypeLabel: string;
}

export async function postSubmissionReplies(
  input: PostSubmissionRepliesInput,
): Promise<void> {
  await Promise.all([
    postConfirmationReply(input),
    postAlertsNotification(input),
  ]);
}

async function postConfirmationReply(
  input: PostSubmissionRepliesInput,
): Promise<void> {
  const { client, record, mondayUrl, approverSlackIds, rush, requestType } = input;

  const reqId = `REQ-${record.monday_item_id}`;
  const approverMentions = approverSlackIds.length > 0
    ? approverSlackIds.map((id) => `<@${id}>`).join(' ')
    : '';

  const rushBanner = rush.isRush
    ? `:warning: *Heads up: tight turnaround.* Marketing typically needs ~2 weeks (1 week to draft + 1 week for approvals and edits) — your timeline is ${rush.daysUntilInHand} day${rush.daysUntilInHand === 1 ? '' : 's'} from today. Marketing will review feasibility before committing; we may need to adjust scope or timeline.\n\n`
    : '';

  const { requestTypePolicy } = await import('../lib/modals/request-modal');
  const policy = requestTypePolicy(requestType, record.originating_channel_id);
  const policyBanner = policy ? `${policy.text}\n\n` : '';

  // Approver line: tag them as listed approvers, but NO buttons here —
  // approval buttons fire when marketing flips Monday status to
  // Pending review (handled by lifecycle-composer.ts). Per Kat
  // 2026-05-06: there's nothing to approve at submission time.
  const approverLine = approverMentions
    ? `\n\n${approverMentions} — you're listed as an approver. I'll tag you again when there's a draft ready for your review.`
    : '';

  const text =
    `${rushBanner}${policyBanner}Got it — tracking your request as <${mondayUrl}|${reqId}>.\n\n` +
    `*What happens next:*\n` +
    `  • Marketing will review the scope and start work once accepted. Status updates post here.\n` +
    `  • Need to add a supporting doc or change something? Just @Sage in this thread.` +
    approverLine;

  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];

  try {
    await client.chat.postMessage({
      channel: record.originating_channel_id,
      thread_ts: record.originating_thread_ts,
      text: `Got it — tracking your request as ${reqId}.`, // notification text
      blocks,
    });
  } catch (err) {
    console.error('[submission-replies] Confirmation reply failed:', err);
    await trackError(err, undefined, {
      source: 'submission-confirmation',
      monday: record.monday_item_id,
    });
  }
}

async function postAlertsNotification(
  input: PostSubmissionRepliesInput,
): Promise<void> {
  const {
    client,
    record,
    mondayUrl,
    approverSlackIds,
    deliverableSummary,
    deadline,
    liveDate,
    rush,
    requesterName,
    division,
    requestTypeLabel,
  } = input;

  const alertChannelId = findAlertsChannel();
  if (!alertChannelId) {
    console.warn('[submission-replies] No alerts-role channel configured; skipping notification.');
    return;
  }

  // Build the threaded permalink to the originating message so marketing
  // can jump straight to the requester's thread.
  let threadPermalink = '';
  try {
    const result = await client.chat.getPermalink({
      channel: record.originating_channel_id,
      message_ts: record.originating_thread_ts,
    });
    threadPermalink = result.permalink ?? '';
  } catch {
    // Best-effort; message still posts without it.
  }

  const summary = deliverableSummary.length > 100
    ? deliverableSummary.slice(0, 97).trim() + '…'
    : deliverableSummary.trim();

  const dueLine = deadline
    ? `Due: ${deadline}`
    : liveDate
    ? `Live: ${liveDate}`
    : 'Due: no deadline';
  const liveLine = deadline && liveDate ? `\n• Live: ${liveDate}` : '';
  const approverNamesLine = approverSlackIds.length > 0
    ? `Approvers: ${approverSlackIds.map((id) => `<@${id}>`).join(', ')}`
    : 'Approvers: none listed';

  const rushPrefix = rush.isRush ? `🚨 *RUSH (${rush.daysUntilInHand}d)* — ` : '';

  const text =
    `${rushPrefix}📥 *New ${requestTypeLabel} from ${requesterName} (${division})*: ${summary}\n` +
    `• ${dueLine}${liveLine}\n` +
    `• ${approverNamesLine}\n` +
    `• <${mondayUrl}|View on Monday>` +
    (threadPermalink ? ` · <${threadPermalink}|Original thread>` : '');

  try {
    const result = await client.chat.postMessage({
      channel: alertChannelId,
      text,
    });

    if (result.ts) {
      await updateRequestAlertInfo(record.id, alertChannelId, result.ts);
      await logRequestEvent({
        eventType: 'alert_posted',
        userId: record.requester_user_id,
        channelId: alertChannelId,
        channelRole: 'alerts',
        mondayItemId: record.monday_item_id,
      });
    }
  } catch (err) {
    console.error('[submission-replies] Alert notification failed:', err);
    await trackError(err, undefined, {
      source: 'submission-alert',
      monday: record.monday_item_id,
    });
  }
}

/**
 * Look up the configured alerts channel ID from channels.yaml. Returns
 * null if no alerts-role channel is configured.
 *
 * Reads the YAML directly via the same loader that division-lookup uses.
 * For now we just iterate via roleForChannel since we don't have a
 * "find channel by role" helper — channel-router stores the role per
 * channel ID, but we need the reverse lookup here.
 */
function findAlertsChannel(): string | null {
  if (process.env.SAGE_V2_ALERTS_CHANNEL_ID) {
    return process.env.SAGE_V2_ALERTS_CHANNEL_ID;
  }
  const channels = findChannelsByRole('alerts');
  return channels[0] ?? null;
}
