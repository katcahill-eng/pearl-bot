import type { App } from '@slack/bolt';
import { config } from '../lib/config';
import { getConversationById, updateTriageInfo } from '../lib/db';
import { ConversationManager, generateProjectName, type CollectedData } from '../lib/conversation';
import { executeApprovedWorkflow, buildCompletionMessage } from '../lib/workflow';
import { buildNotificationMessage } from '../lib/notifications';
import { updateMondayItemStatus, addMondayItemUpdate, buildMondayUrl } from '../lib/monday';

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
    default:
      return 'updated the status of your request.';
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

  // Build deliverables line
  const deliverablesLine = collectedData.deliverables.length > 0
    ? collectedData.deliverables.join(', ')
    : 'Not specified';

  // Build request type label
  const requestType = collectedData.request_type ?? 'Not specified';

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
        { type: 'mrkdwn', text: `*Department:*\n${collectedData.requester_department ?? 'Not specified'}` },
        { type: 'mrkdwn', text: `*Status:*\n${status}` },
        { type: 'mrkdwn', text: `*Type:*\n${requestType}` },
        { type: 'mrkdwn', text: `*Classification:*\n${classificationLabel(classification)} — ${classificationExplanation(classification)}` },
        { type: 'mrkdwn', text: `*Due Date:*\n${collectedData.due_date ?? 'Not specified'}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Summary:*\n${oneLiner}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Target:*\n${collectedData.target ?? 'Not specified'}` },
        { type: 'mrkdwn', text: `*Deliverables:*\n${deliverablesLine}` },
      ],
    },
  ];

  // Add desired outcomes if present
  if (collectedData.desired_outcomes) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Desired Outcomes:*\n${collectedData.desired_outcomes}`,
      },
    });
  }

  // Add existing content/assets if present
  let existingAssetsText = '';
  try {
    const assetsRaw = collectedData.additional_details['__existing_assets'];
    if (assetsRaw) {
      const assets = JSON.parse(assetsRaw) as { link: string; status: string }[];
      if (assets.length > 0) {
        existingAssetsText = assets.map((a) => `• ${a.link} — _${a.status}_`).join('\n');
      }
    }
  } catch { /* ignore */ }

  if (existingAssetsText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Existing Content:*\n${existingAssetsText}`,
      },
    });
  }

  // Add discussion flags if present
  let discussionText = '';
  try {
    const flagsRaw = collectedData.additional_details['__needs_discussion'];
    if (flagsRaw) {
      const flags = JSON.parse(flagsRaw) as { field: string; label: string }[];
      if (flags.length > 0) {
        discussionText = flags.map((f) => `• ${f.label.replace(/_/g, ' ')}`).join('\n');
      }
    }
  } catch { /* ignore */ }

  if (discussionText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:speech_balloon: *Needs Discussion:*\n${discussionText}`,
      },
    });
  }

  // Related projects (auto-detected from keywords)
  let relatedProjectsText = '';
  try {
    const relatedRaw = collectedData.additional_details['__related_projects'];
    if (relatedRaw) {
      const names = JSON.parse(relatedRaw) as string[];
      if (names.length > 0) {
        relatedProjectsText = names.map((n) => `• ${n}`).join('\n');
      }
    }
  } catch { /* ignore */ }

  if (relatedProjectsText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:link: *Possibly related to:*\n${relatedProjectsText}`,
      },
    });
  }

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

    // Post triage guide as a threaded reply for context
    try {
      await client.chat.postMessage({
        channel: config.slackNotificationChannelId,
        thread_ts: result.ts,
        text: triageGuideText(),
      });
    } catch (err) {
      console.error('[approval] Failed to post triage guide:', err);
    }
  }
}

function triageGuideText(): string {
  return (
    ':clipboard: *Triage Guide*\n\n' +
    '*What to do:*\n' +
    '1. Review the request details above\n' +
    '2. Use the *Change Status* dropdown to move it through the workflow\n' +
    '3. Use *Notify Requester* to send them a status update\n\n' +
    '*Statuses:*\n' +
    '• *Under Review* — Default. You\'re looking at it.\n' +
    '• *Discussion Needed* — Auto-DMs the requester with a calendar link to schedule time.\n' +
    '• *In Progress* — Approved. Creates a brief + Drive folder (Full Projects) or updates Monday (Quick Requests).\n' +
    '• *On Hold* — Paused. Requester is notified.\n' +
    '• *Completed* — Done. Locks the panel.\n' +
    '• *Declined* — Not taking it on. Requester is notified.\n' +
    '• *Withdrawn* — Requester cancelled.\n\n' +
    '*Classification:*\n' +
    '• *Quick Request* — Single asset, goes straight to the team.\n' +
    '• *Full Project* — Generates a brief + Google Drive folder on approval.\n\n' +
    '_You can reclassify at any time using the Classification dropdown._'
  );
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
    const requesterName = collectedData.requester_name ?? convo.getUserName();
    const actorName = body.user?.name ?? body.user?.id ?? 'Unknown';

    const projectName = generateProjectName(collectedData);

    // Build Monday URL from existing item
    const mondayItemId = convo.getMondayItemId();
    const mondayUrl = mondayItemId ? buildMondayUrl(mondayItemId) : null;

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

        // Always send the success message to the requester — never expose internal errors
        try {
          await client.chat.postMessage({
            channel: convo.getChannelId(),
            text: ':tada: *All set! Your request has been approved and is now in progress.*\n\nThe marketing team has been notified and will begin working on your request.\nReply to me anytime to check on status.\n\n_I\'m your intake assistant — the marketing team will take it from here!_',
            thread_ts: convo.getThreadTs(),
          });
        } catch (err) {
          console.error('[approval] Failed to notify requester:', err);
        }

        // If there are workflow errors, post them to triage thread ONLY (never to requester)
        if (result.errors.length > 0 && body.message && body.channel?.id) {
          const errorLines = result.errors.map((e: string) => `• :x: ${e}`).join('\n');
          try {
            await client.chat.postMessage({
              channel: body.channel.id,
              text: `:warning: *Post-approval setup issues:*\n${errorLines}\n\nThe requester has been notified that their request is in progress. These errors need manual resolution.`,
              thread_ts: body.message.ts,
            });
          } catch (err) {
            console.error('[approval] Failed to post error details to triage:', err);
          }
        }
      }

      convo.setStatus('complete');
      await convo.save();
    }

    if (newStatus === 'On Hold') {
      // Update Monday.com status if item exists
      if (mondayItemId) {
        try {
          await updateMondayItemStatus(mondayItemId, 'Stuck');
        } catch (err) {
          console.error('[approval] Failed to update Monday.com status to On Hold:', err);
        }
      }
    }

    if (newStatus === 'Completed') {
      // Update Monday.com status if item exists
      if (mondayItemId) {
        try {
          await updateMondayItemStatus(mondayItemId, 'Completed/Live');
        } catch (err) {
          console.error('[approval] Failed to update Monday.com status to Completed:', err);
        }
      }

      convo.setStatus('complete');
      await convo.save();

      // Auto-notify requester that their request is complete
      try {
        await client.chat.postMessage({
          channel: convo.getChannelId(),
          text: ':white_check_mark: Great news — your request has been completed! If you have any feedback or need anything else, feel free to start a new request anytime.',
          thread_ts: convo.getThreadTs(),
        });
      } catch (err) {
        console.error('[approval] Failed to notify requester of completion:', err);
      }
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
          await updateMondayItemStatus(mondayItemId, 'Withdrawn');
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
    await convo.save();

    const collectedData = convo.getCollectedData();
    const requesterName = collectedData.requester_name ?? convo.getUserName();
    const projectName = generateProjectName(collectedData);

    // Determine current status from the status dropdown in the message
    const currentStatus = extractCurrentStatus(body) ?? 'Under Review';

    // Build Monday URL
    const mondayItemId = convo.getMondayItemId();
    const mondayUrl = mondayItemId ? buildMondayUrl(mondayItemId) : null;

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
