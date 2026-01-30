import type { App } from '@slack/bolt';
import { config } from '../lib/config';
import { getConversationById } from '../lib/db';
import { ConversationManager, type CollectedData } from '../lib/conversation';
import { executeApprovedWorkflow, buildCompletionMessage } from '../lib/workflow';
import { buildNotificationMessage } from '../lib/notifications';

// --- Types ---

interface ApprovalRequestParams {
  conversationId: number;
  projectName: string;
  classification: 'quick' | 'full';
  collectedData: CollectedData;
  requesterName: string;
  mondayItemId: string;
  mondayUrl: string;
}

// --- Public API ---

/**
 * Post an approval request to #mktg-triage with Approve / Let's Discuss buttons.
 */
export async function sendApprovalRequest(
  client: import('@slack/web-api').WebClient,
  params: ApprovalRequestParams,
): Promise<void> {
  const { conversationId, projectName, classification, collectedData, requesterName, mondayItemId, mondayUrl } = params;

  const levelOfEffort = classification === 'quick' ? 'Quick Request' : 'Full Project';
  const description = collectedData.context_background ?? 'No description provided';
  const oneLiner = description.includes('.')
    ? description.split('.')[0] + '.'
    : description.slice(0, 120);

  const notificationChannelId = config.slackNotificationChannelId;

  await client.chat.postMessage({
    channel: notificationChannelId,
    text: `New ${levelOfEffort} Awaiting Approval: ${projectName}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `New ${levelOfEffort} Awaiting Approval`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Requester:*\n${requesterName}` },
          { type: 'mrkdwn', text: `*Classification:*\n${levelOfEffort}` },
          { type: 'mrkdwn', text: `*Summary:*\n${oneLiner}` },
          { type: 'mrkdwn', text: `*Target:*\n${collectedData.target ?? 'Not specified'}` },
          { type: 'mrkdwn', text: `*Due Date:*\n${collectedData.due_date ?? 'Not specified'}` },
          { type: 'mrkdwn', text: `*Monday.com:*\n<${mondayUrl}|View item>` },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: 'approval_approve',
            value: JSON.stringify({ conversationId, mondayItemId }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: "Let's Discuss" },
            action_id: 'approval_discuss',
            value: JSON.stringify({ conversationId }),
          },
        ],
      },
    ],
  });
}

/**
 * Register Slack action handlers for the approval buttons.
 */
export function registerApprovalHandler(app: App): void {
  // --- Approve ---
  app.action('approval_approve', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions' || !body.actions?.[0]) return;

    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId, mondayItemId } = JSON.parse(action.value) as {
      conversationId: number;
      mondayItemId: string;
    };

    // Load conversation
    const row = getConversationById(conversationId);
    if (!row) {
      console.error('[approval] Conversation not found:', conversationId);
      return;
    }

    // Guard: only process if still pending_approval
    if (row.status !== 'pending_approval') {
      // Already processed — update the message to reflect that
      if (body.message && body.channel?.id) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: 'This request has already been processed.',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: ':information_source: This request has already been processed.' },
            },
          ],
        });
      }
      return;
    }

    const convo = ConversationManager.load(row.user_id, row.thread_ts);
    if (!convo) {
      console.error('[approval] Could not load ConversationManager for:', conversationId);
      return;
    }

    const collectedData = convo.getCollectedData();
    const classification = convo.getClassification() === 'undetermined' ? 'quick' : convo.getClassification() as 'quick' | 'full';
    const requesterName = convo.getUserName();

    // Determine the Monday.com board ID based on classification
    const mondayBoardId = classification === 'quick'
      ? config.mondayQuickBoardId
      : config.mondayFullBoardId;

    // Execute the post-approval workflow
    const result = await executeApprovedWorkflow({
      collectedData,
      classification,
      requesterName,
      requesterSlackId: convo.getUserId(),
      mondayItemId,
      mondayBoardId,
      source: 'conversation',
    });

    // Mark conversation complete
    convo.setStatus('complete');
    convo.save();

    // Remove buttons from the approval message
    if (body.message && body.channel?.id) {
      const approvedBy = body.user?.name ?? body.user?.id ?? 'Unknown';
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `Approved by ${approvedBy}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Approved* by ${approvedBy}`,
            },
          },
        ],
      });
    }

    // Post notification to marketing channel
    const projectName =
      collectedData.context_background?.slice(0, 80) ??
      collectedData.deliverables[0] ??
      'Untitled Request';

    if (result.success) {
      try {
        const notification = buildNotificationMessage({
          projectName,
          classification,
          collectedData,
          requesterName,
          result,
        });
        await client.chat.postMessage({
          channel: config.slackNotificationChannelId,
          text: notification,
        });
      } catch (err) {
        console.error('[approval] Failed to post notification:', err);
      }
    }

    // Notify requester that request was approved
    try {
      const completionMsg = buildCompletionMessage(result, classification);
      await client.chat.postMessage({
        channel: convo.getChannelId(),
        text: completionMsg,
        thread_ts: convo.getThreadTs(),
      });
    } catch (err) {
      console.error('[approval] Failed to notify requester:', err);
    }
  });

  // --- Let's Discuss ---
  app.action('approval_discuss', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions' || !body.actions?.[0]) return;

    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId } = JSON.parse(action.value) as {
      conversationId: number;
    };

    // Load conversation
    const row = getConversationById(conversationId);
    if (!row) {
      console.error('[approval] Conversation not found:', conversationId);
      return;
    }

    // Guard: only process if still pending_approval
    if (row.status !== 'pending_approval') {
      if (body.message && body.channel?.id) {
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: 'This request has already been processed.',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: ':information_source: This request has already been processed.' },
            },
          ],
        });
      }
      return;
    }

    // Monday.com item stays "Under Review" — no status change needed

    // Remove buttons from the approval message
    if (body.message && body.channel?.id) {
      const discussBy = body.user?.name ?? body.user?.id ?? 'Unknown';
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `Discussion requested by ${discussBy}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:speech_balloon: *Discussion requested* by ${discussBy}`,
            },
          },
        ],
      });

      // Post confirmation in thread
      await client.chat.postMessage({
        channel: body.channel.id,
        text: `${discussBy} wants to discuss this request before approving. The requester has been sent a calendar link.`,
        thread_ts: body.message.ts,
      });
    }

    // DM the requester with a calendar booking link
    const calendarUrl = config.marketingLeadCalendarUrl;
    const calendarLine = calendarUrl
      ? `\n\nPlease book a 30-minute call to discuss: ${calendarUrl}`
      : '\n\nPlease tag someone from the marketing team in #marcoms-requests to schedule a discussion.';

    try {
      // Open a DM channel with the requester
      const dmResult = await client.conversations.open({
        users: row.user_id,
      });
      const dmChannelId = dmResult.channel?.id;
      if (dmChannelId) {
        await client.chat.postMessage({
          channel: dmChannelId,
          text: `Hi! The marketing team would like to learn more about your request before moving forward.${calendarLine}`,
        });
      }
    } catch (err) {
      console.error('[approval] Failed to DM requester:', err);
    }
  });
}
