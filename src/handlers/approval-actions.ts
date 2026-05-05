/**
 * Sage v2 Approve / Request-changes button handlers.
 *
 * The buttons are posted in the confirmation reply (US-012) with
 * action_ids APPROVE_ACTION_ID and REQUEST_CHANGES_ACTION_ID. The
 * button value is the request_records.id (as string).
 *
 * On approve_request:
 *   - Verify the clicker is in the request's approvers list (else
 *     ephemeral message)
 *   - Record the action
 *   - Move Monday status to "Under Review" (the existing label that
 *     marks something as ready for marketing triage)
 *   - Post in-thread confirmation
 *
 * On request_changes:
 *   - Same approver check
 *   - Open a small modal asking for the changes
 *   - On modal submit: post the changes as a Monday update + in-thread
 *     reply; do NOT change status
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import {
  APPROVE_ACTION_ID,
  REQUEST_CHANGES_ACTION_ID,
} from './submission-replies';
import {
  recordApproverAction,
  getRequestById,
} from '../lib/db';
import { addMondayItemUpdate, updateMondayItemStatus } from '../lib/monday';
import { logRequestEvent } from '../lib/event-log';
import { trackError } from '../lib/error-tracker';

const REQUEST_CHANGES_MODAL_CALLBACK = 'sage_v2_request_changes_modal';

interface ChangesModalMetadata {
  requestId: number;
  monday_item_id: string;
  channelId: string;
  threadTs: string;
}

export function registerApprovalActionsV2(app: App): void {
  app.action(APPROVE_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    try {
      const action = (body as BlockAction).actions?.[0] as ButtonAction;
      if (!action?.value) return;
      const requestId = parseInt(action.value, 10);
      if (isNaN(requestId)) return;

      const userId = (body as BlockAction).user?.id;
      if (!userId) return;

      const record = await getRequestById(requestId);
      if (!record) return;

      if (!record.approver_user_ids.includes(userId)) {
        await client.chat.postEphemeral({
          channel: record.originating_channel_id,
          user: userId,
          text: 'Only listed approvers can act on this request.',
        });
        return;
      }

      await recordApproverAction(requestId, userId, 'approved');

      // Move Monday status forward.
      try {
        await updateMondayItemStatus(record.monday_item_id, 'Working on it');
      } catch (err) {
        console.error('[approval-actions] Status update failed:', err);
      }

      await client.chat.postMessage({
        channel: record.originating_channel_id,
        thread_ts: record.originating_thread_ts,
        text: `Approved by <@${userId}>.`,
      });

      await logRequestEvent({
        eventType: 'request_approved',
        userId,
        channelId: record.originating_channel_id,
        mondayItemId: record.monday_item_id,
      });
    } catch (err) {
      console.error('[approval-actions] approve_request failed:', err);
      await trackError(err, undefined, { source: 'approve_request' });
    }
  });

  app.action(REQUEST_CHANGES_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    try {
      const action = (body as BlockAction).actions?.[0] as ButtonAction;
      const triggerId = (body as any).trigger_id as string | undefined;
      if (!action?.value || !triggerId) return;
      const requestId = parseInt(action.value, 10);
      if (isNaN(requestId)) return;

      const userId = (body as BlockAction).user?.id;
      if (!userId) return;

      const record = await getRequestById(requestId);
      if (!record) return;

      if (!record.approver_user_ids.includes(userId)) {
        await client.chat.postEphemeral({
          channel: record.originating_channel_id,
          user: userId,
          text: 'Only listed approvers can act on this request.',
        });
        return;
      }

      const metadata: ChangesModalMetadata = {
        requestId,
        monday_item_id: record.monday_item_id,
        channelId: record.originating_channel_id,
        threadTs: record.originating_thread_ts,
      };

      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: 'modal',
          callback_id: REQUEST_CHANGES_MODAL_CALLBACK,
          private_metadata: JSON.stringify(metadata),
          title: { type: 'plain_text', text: 'Request changes' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'changes',
              label: {
                type: 'plain_text',
                text: 'What changes do you want to see?',
              },
              element: {
                type: 'plain_text_input',
                action_id: 'value',
                multiline: true,
              },
            },
          ],
        },
      });
    } catch (err) {
      console.error('[approval-actions] request_changes failed:', err);
      await trackError(err, undefined, { source: 'request_changes' });
    }
  });

  // Modal submission for the "Request changes" path.
  app.view(REQUEST_CHANGES_MODAL_CALLBACK, async ({ ack, body, view, client }) => {
    await ack();
    try {
      const metadata: ChangesModalMetadata = JSON.parse(view.private_metadata);
      const userId = body.user.id;
      const changes =
        view.state.values?.changes?.value?.value as string | undefined;

      if (!changes) return;

      await recordApproverAction(metadata.requestId, userId, 'requested_changes', changes);

      try {
        await addMondayItemUpdate(
          metadata.monday_item_id,
          `Changes requested by Slack user ${userId}: ${changes}`,
        );
      } catch (err) {
        console.error('[approval-actions] Monday update failed:', err);
      }

      await client.chat.postMessage({
        channel: metadata.channelId,
        thread_ts: metadata.threadTs,
        text: `Changes requested by <@${userId}>:\n> ${changes}`,
      });

      await logRequestEvent({
        eventType: 'changes_requested',
        userId,
        channelId: metadata.channelId,
        mondayItemId: metadata.monday_item_id,
      });
    } catch (err) {
      console.error('[approval-actions] changes-modal submit failed:', err);
      await trackError(err, undefined, { source: 'changes_modal_submit' });
    }
  });
}

