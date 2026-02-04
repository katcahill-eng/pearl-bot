import type { App } from '@slack/bolt';
import { config } from '../lib/config';
import { getConversationById, updateTriageInfo } from '../lib/db';
import { ConversationManager, type CollectedData } from '../lib/conversation';
import { executeApprovedWorkflow, buildCompletionMessage } from '../lib/workflow';
import { buildNotificationMessage } from '../lib/notifications';
import { updateMondayItemStatus, addMondayItemUpdate } from '../lib/monday';

// --- Types ---

interface ApprovalRequestParams {
  conversationId: number;
  projectName: string;
  classification: 'quick' | 'full';
  collectedData: CollectedData;
  requesterName: string;
  mondayItemId?: string | null;
  mondayUrl?: string | null;
}

type TriageStatus = 'Under Review' | 'Discussion Needed' | 'In Progress' | 'On Hold' | 'Completed' | 'Declined' | 'Withdrawn';

// --- Helpers ---

function classificationLabel(classification: 'quick' | 'full'): string {
  return classification === 'quick' ? 'Quick Request' : 'Full Project';
}

function classificationExplanation(classification: 'quick' | 'full'): string {
  return classification === 'quick'
    ? 'Single asset, straight to team (no brief/Drive)'
    : 'Generates brief + Drive folder on approval';
}

function statusContextMessage(status: TriageStatus): string {
  switch (status) {
    case 'Under Review':
      return 'reviewing your request and will follow up soon.';
    case 'Discussion Needed':
      return 'looking into your request and would like to discuss it further.';
    case 'In Progress':
      return 'actively working on your request.';
    case 'On Hold':
      return 'pausing work on your request temporarily. We\'ll let you know when it resumes.';
    case 'Completed':
      return 'finished working on your request.';
    case 'Declined':
      return 'unable to take on this request at this time.';
    case 'Withdrawn':
      return 'marked your request as withdrawn.';
  }
}

/**
 * Build the triage control panel blocks for the approval message.
 */
function buildTriageBlocks(opts: {
  conversationId: number;
  projectName: string;
  classification: 'quick' | 'full';
  collectedData: CollectedData;
  requesterName: string;
  status: TriageStatus;
  lockedBy?: string;
  mondayUrl?: string | null;
}): any[] {
  const { conversationId, projectName, classification, collectedData, requesterName, status, lockedBy, mondayUrl } = opts;

  const oneLiner = collectedData.context_background
    ? (collectedData.context_background.includes('.')
      ? collectedData.context_background.split('.')[0] + '.'
      : collectedData.context_background.slice(0, 120))
    : 'No description provided';

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: projectName.slice(0, 150),
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Requester:*\n${requesterName}` },
        { type: 'mrkdwn', text: `*Status:*\n${status}` },
        { type: 'mrkdwn', text: `*Classification:*\n${classificationLabel(classification)} — ${classificationExplanation(classification)}` },
        { type: 'mrkdwn', text: `*Summary:*\n${oneLiner}` },
        { type: 'mrkdwn', text: `*Target:*\n${collectedData.target ?? 'Not specified'}` },
        { type: 'mrkdwn', text: `*Due Date:*\n${collectedData.due_date ?? 'Not specified'}` },
      ],
    },
  ];

  // Monday.com link section
  if (mondayUrl) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:link: <${mondayUrl}|View on Monday.com>`,
      },
    });
  }

  // Terminal states — show locked message instead of controls
  if (status === 'Completed' || status === 'Declined' || status === 'Withdrawn') {
    const icon = status === 'Completed' ? ':white_check_mark:' : status === 'Withdrawn' ? ':no_entry:' : ':no_entry_sign:';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${status}* by ${lockedBy ?? 'Unknown'}`,
      },
    });
    return blocks;
  }

  // Active states — show dropdowns + notify button
  const actionValue = JSON.stringify({ conversationId });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'static_select',
        placeholder: { type: 'plain_text', text: 'Change Status' },
        action_id: 'approval_status_change',
        initial_option: {
          text: { type: 'plain_text', text: status },
          value: status,
        },
        options: [
          { text: { type: 'plain_text', text: 'Under Review' }, value: 'Under Review' },
          { text: { type: 'plain_text', text: 'Discussion Needed' }, value: 'Discussion Needed' },
          { text: { type: 'plain_text', text: 'In Progress' }, value: 'In Progress' },
          { text: { type: 'plain_text', text: 'On Hold' }, value: 'On Hold' },
          { text: { type: 'plain_text', text: 'Completed' }, value: 'Completed' },
          { text: { type: 'plain_text', text: 'Declined' }, value: 'Declined' },
          { text: { type: 'plain_text', text: 'Withdrawn' }, value: 'Withdrawn' },
        ],
      },
      {
        type: 'static_select',
        placeholder: { type: 'plain_text', text: 'Classification' },
        action_id: 'approval_reclassify',
        initial_option: {
          text: { type: 'plain_text', text: classificationLabel(classification) },
          value: classification,
        },
        options: [
          { text: { type: 'plain_text', text: 'Quick Request' }, value: 'quick' },
          { text: { type: 'plain_text', text: 'Full Project' }, value: 'full' },
        ],
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Notify Requester' },
        action_id: 'approval_notify',
        value: actionValue,
      },
    ],
  });

  return blocks;
}

// --- Public API ---

/**
 * Post a triage control panel to #mktg-triage.
 */
export async function sendApprovalRequest(
  client: import('@slack/web-api').WebClient,
  params: ApprovalRequestParams,
): Promise<void> {
  const { conversationId, projectName, classification, collectedData, requesterName, mondayItemId, mondayUrl } = params;

  const blocks = buildTriageBlocks({
    conversationId,
    projectName,
    classification,
    collectedData,
    requesterName,
    status: 'Under Review',
    mondayUrl,
  });

  const result = await client.chat.postMessage({
    channel: config.slackNotificationChannelId,
    text: `New request for triage: ${projectName}`,
    metadata: {
      event_type: 'triage_panel',
      event_payload: { conversationId, projectName, classification },
    },
    blocks,
  });

  // Store triage message timestamp for post-submission thread handling
  if (result.ts) {
    try {
      await updateTriageInfo(conversationId, result.ts, config.slackNotificationChannelId);
    } catch (err) {
      console.error('[approval] Failed to store triage info:', err);
    }
  }
}

/**
 * Register Slack action handlers for the triage control panel.
 */
export function registerApprovalHandler(app: App): void {
  // --- Status Change ---
  app.action('approval_status_change', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const newStatus = action.selected_option?.value as TriageStatus;
    if (!newStatus) return;

    // Extract conversationId from the notify button value in the same actions block
    const conversationId = extractConversationId(body);
    if (!conversationId) {
      console.error('[approval] Could not extract conversationId from message');
      return;
    }

    const row = await getConversationById(conversationId);
    if (!row) {
      console.error('[approval] Conversation not found:', conversationId);
      return;
    }

    const convo = await ConversationManager.load(row.user_id, row.thread_ts);
    if (!convo) {
      console.error('[approval] Could not load ConversationManager for:', conversationId);
      return;
    }

    const collectedData = convo.getCollectedData();
    const classification = convo.getClassification() === 'undetermined' ? 'quick' : convo.getClassification() as 'quick' | 'full';
    const requesterName = convo.getUserName();
    const actorName = body.user?.name ?? body.user?.id ?? 'Unknown';

    const projectName =
      collectedData.context_background?.slice(0, 80) ??
      collectedData.deliverables[0] ??
      'Untitled Request';

    // Build Monday URL from existing item
    const mondayItemId = convo.getMondayItemId();
    const mondayBoardId = classification === 'quick' ? config.mondayQuickBoardId : config.mondayFullBoardId;
    const mondayUrl = mondayItemId ? `https://pearl-certification.monday.com/boards/${mondayBoardId}/pulses/${mondayItemId}` : null;

    // --- Handle each status ---

    if (newStatus === 'Discussion Needed') {
      // Notify requester in their thread
      try {
        await client.chat.postMessage({
          channel: convo.getChannelId(),
          text: 'The marketing team would like to discuss your request further. Someone will reach out to schedule a time.',
          thread_ts: convo.getThreadTs(),
        });
      } catch (err) {
        console.error('[approval] Failed to notify requester thread:', err);
      }

      // DM requester with calendar link
      const calendarUrl = config.marketingLeadCalendarUrl;
      const calendarLine = calendarUrl
        ? `\n\nPlease book a 30-minute call to discuss: ${calendarUrl}`
        : '\n\nPlease tag someone from the marketing team in #marcoms-requests to schedule a discussion.';

      try {
        const dmResult = await client.conversations.open({ users: row.user_id });
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
    }

    if (newStatus === 'In Progress') {
      // Monday item already exists (created at submission). Run approval workflow.
      if (!mondayItemId) {
        console.error('[approval] No Monday item found for conversation', conversationId, '— cannot run In Progress workflow');
        // Post warning to triage thread
        if (body.message && body.channel?.id) {
          await client.chat.postMessage({
            channel: body.channel.id,
            text: ':warning: No Monday.com item found for this request. The item may not have been created at submission time.',
            thread_ts: body.message.ts,
          });
        }
      } else {
        // Run the approval workflow (brief/Drive for full, status update for both)
        const result = await executeApprovedWorkflow({
          collectedData,
          classification,
          requesterName,
          requesterSlackId: convo.getUserId(),
          mondayItemId,
          mondayBoardId,
          source: 'conversation',
        });

        // Post notification to marketing channel
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

        // Notify requester
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
      }

      convo.setStatus('complete');
      await convo.save();
    }

    if (newStatus === 'On Hold') {
      // Update Monday.com status if item exists
      if (mondayItemId) {
        try {
          await updateMondayItemStatus(mondayItemId, mondayBoardId, 'Stuck');
        } catch (err) {
          console.error('[approval] Failed to update Monday.com status to On Hold:', err);
        }
      }
    }

    if (newStatus === 'Completed') {
      // Update Monday.com status if item exists
      if (mondayItemId) {
        try {
          await updateMondayItemStatus(mondayItemId, mondayBoardId, 'Done');
        } catch (err) {
          console.error('[approval] Failed to update Monday.com status to Completed:', err);
        }
      }

      convo.setStatus('complete');
      await convo.save();
    }

    if (newStatus === 'Declined') {
      convo.setStatus('cancelled');
      await convo.save();

      // Notify requester
      try {
        await client.chat.postMessage({
          channel: convo.getChannelId(),
          text: 'Your request was reviewed and was not approved at this time.',
          thread_ts: convo.getThreadTs(),
        });
      } catch (err) {
        console.error('[approval] Failed to notify requester of decline:', err);
      }
    }

    if (newStatus === 'Withdrawn') {
      convo.setStatus('withdrawn');
      await convo.save();

      // Update Monday.com
      if (mondayItemId) {
        try {
          await updateMondayItemStatus(mondayItemId, mondayBoardId, 'Withdrawn');
        } catch (err) {
          console.error('[approval] Failed to update Monday.com to Withdrawn:', err);
        }
        try {
          await addMondayItemUpdate(mondayItemId, `Request withdrawn by ${actorName}.`);
        } catch (err) {
          console.error('[approval] Failed to add Monday.com withdrawal update:', err);
        }
      }

      // Notify requester
      try {
        await client.chat.postMessage({
          channel: convo.getChannelId(),
          text: 'Your request has been withdrawn by the marketing team.',
          thread_ts: convo.getThreadTs(),
        });
      } catch (err) {
        console.error('[approval] Failed to notify requester of withdrawal:', err);
      }
    }

    // Update the triage message with new status
    if (body.message && body.channel?.id) {
      const isLocked = newStatus === 'Completed' || newStatus === 'Declined' || newStatus === 'Withdrawn';
      const blocks = buildTriageBlocks({
        conversationId,
        projectName,
        classification,
        collectedData,
        requesterName,
        status: newStatus,
        lockedBy: isLocked ? actorName : undefined,
        mondayUrl,
      });

      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `${projectName} — ${newStatus}`,
        blocks,
      });
    }
  });

  // --- Classification Change ---
  app.action('approval_reclassify', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (action.type !== 'static_select') return;

    const newClassification = action.selected_option?.value as 'quick' | 'full';
    if (!newClassification) return;

    const conversationId = extractConversationId(body);
    if (!conversationId) {
      console.error('[approval] Could not extract conversationId from message');
      return;
    }

    const row = await getConversationById(conversationId);
    if (!row) {
      console.error('[approval] Conversation not found:', conversationId);
      return;
    }

    const convo = await ConversationManager.load(row.user_id, row.thread_ts);
    if (!convo) {
      console.error('[approval] Could not load ConversationManager for:', conversationId);
      return;
    }

    // Update classification
    convo.setClassification(newClassification);
    convo.save();

    const collectedData = convo.getCollectedData();
    const requesterName = convo.getUserName();
    const projectName =
      collectedData.context_background?.slice(0, 80) ??
      collectedData.deliverables[0] ??
      'Untitled Request';

    // Determine current status from the status dropdown in the message
    const currentStatus = extractCurrentStatus(body) ?? 'Under Review';

    // Build Monday URL
    const mondayItemId = convo.getMondayItemId();
    const mondayBoardId = newClassification === 'quick' ? config.mondayQuickBoardId : config.mondayFullBoardId;
    const mondayUrl = mondayItemId ? `https://pearl-certification.monday.com/boards/${mondayBoardId}/pulses/${mondayItemId}` : null;

    // Refresh the triage message
    if (body.message && body.channel?.id) {
      const blocks = buildTriageBlocks({
        conversationId,
        projectName,
        classification: newClassification,
        collectedData,
        requesterName,
        status: currentStatus,
        mondayUrl,
      });

      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `${projectName} — ${currentStatus}`,
        blocks,
      });
    }
  });

  // --- Notify Requester ---
  app.action('approval_notify', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId } = JSON.parse(action.value) as { conversationId: number };

    const row = await getConversationById(conversationId);
    if (!row) {
      console.error('[approval] Conversation not found:', conversationId);
      return;
    }

    const convo = await ConversationManager.load(row.user_id, row.thread_ts);
    if (!convo) {
      console.error('[approval] Could not load ConversationManager for:', conversationId);
      return;
    }

    // Get current status from the dropdown
    const currentStatus = extractCurrentStatus(body) ?? 'Under Review';

    // Post status update in requester's thread
    try {
      await client.chat.postMessage({
        channel: convo.getChannelId(),
        text: `Status update on your request: *${currentStatus}*. The marketing team is ${statusContextMessage(currentStatus as TriageStatus)}`,
        thread_ts: convo.getThreadTs(),
      });
    } catch (err) {
      console.error('[approval] Failed to notify requester:', err);
    }

    // Confirm in triage thread
    if (body.message && body.channel?.id) {
      const actorName = body.user?.name ?? body.user?.id ?? 'Unknown';
      await client.chat.postMessage({
        channel: body.channel.id,
        text: `${actorName} notified the requester (status: ${currentStatus}).`,
        thread_ts: body.message.ts,
      });
    }
  });
}

// --- Utility functions ---

/**
 * Extract conversationId from the notify button in the actions block.
 * The notify button always carries the conversationId in its value.
 */
function extractConversationId(body: any): number | null {
  try {
    const message = body.message;
    if (!message?.blocks) return null;

    for (const block of message.blocks) {
      if (block.type !== 'actions') continue;
      for (const element of block.elements ?? []) {
        if (element.action_id === 'approval_notify' && element.value) {
          const parsed = JSON.parse(element.value);
          return parsed.conversationId ?? null;
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Extract the current status from the status dropdown's initial_option in the message.
 */
function extractCurrentStatus(body: any): TriageStatus | null {
  try {
    const message = body.message;
    if (!message?.blocks) return null;

    for (const block of message.blocks) {
      if (block.type !== 'actions') continue;
      for (const element of block.elements ?? []) {
        if (element.action_id === 'approval_status_change' && element.initial_option?.value) {
          return element.initial_option.value as TriageStatus;
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}
