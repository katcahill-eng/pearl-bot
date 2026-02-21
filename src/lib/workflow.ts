import { config } from './config';
import { generateProjectName, type CollectedData } from './conversation';
import type { RequestClassification } from './claude';
import { generateBrief } from './brief-generator';
import { createFullProjectDrive, allocateNextMktNumber, type DriveResult } from './google-drive';
import { createRequestItem, updateMondayItemStatus, updateMondayItemColumns, addMondayItemUpdate, buildMondayUrl, classifyDeliverableType, findMondayUserByEmail, MONDAY_COLUMNS, type MondayResult } from './monday';
import { createProject } from './db';
import type { WebClient } from '@slack/web-api';

// --- Types ---

export interface WorkflowResult {
  success: boolean;
  briefDocUrl?: string;
  folderUrl?: string;
  mondayUrl?: string;
  mondayItemId?: string;
  projectId?: number;
  errors: string[];
}

// --- Public API ---

/**
 * Create a Monday.com item immediately at submission time (before approval).
 * Item is created with "Under Review" status.
 */
export interface MondayItemResult extends MondayResult {
  /** Unmatched deliverables that didn't map to any Monday "Type of Deliverable" label */
  unmatchedDeliverables?: string[];
  /** The deliverable type label that was auto-assigned */
  deliverableTypeLabel?: string | null;
}

export async function createMondayItemForReview(opts: {
  collectedData: CollectedData;
  classification: 'quick' | 'full';
  requesterName: string;
  requesterSlackId: string;
  requestTypes?: string[];
  channelId: string;
  threadTs: string;
  client: WebClient;
}): Promise<MondayItemResult> {
  const { collectedData, requesterName, requesterSlackId, requestTypes, channelId, threadTs, client } = opts;

  const projectName = generateProjectName(collectedData);

  // Build Slack deep link to the originating thread (empty for form submissions)
  const slackThreadLink = channelId && threadTs
    ? `https://slack.com/archives/${channelId}/p${threadTs.replace('.', '')}`
    : null;

  // Gather supporting links from existing assets
  let supportingLinks: string | undefined;
  try {
    const assetsRaw = collectedData.additional_details?.['__existing_assets'];
    if (assetsRaw) {
      const assets = JSON.parse(assetsRaw) as { link: string; status: string }[];
      if (assets.length > 0) {
        supportingLinks = assets.map((a) => `${a.link} (${a.status})`).join('\n');
      }
    }
  } catch { /* ignore */ }

  // Auto-classify deliverable type for Monday's "Type of Deliverable" column
  const deliverableClassification = classifyDeliverableType(
    collectedData.deliverables,
    collectedData.context_background,
    requestTypes ?? null,
  );

  // Look up requester in Monday.com to set as Owner (best-effort)
  let ownerUserId: number | null = null;
  try {
    const userInfo = await client.users.info({ user: requesterSlackId });
    const email = userInfo.user?.profile?.email;
    if (email) {
      ownerUserId = await findMondayUserByEmail(email);
      if (ownerUserId) {
        console.log(`[workflow] Resolved Monday owner: ${email} → userId ${ownerUserId}`);
      } else {
        console.log(`[workflow] No Monday user found for email ${email}`);
      }
    }
  } catch (err) {
    console.error('[workflow] Failed to resolve Monday owner (non-critical):', err);
  }

  const result = await createRequestItem({
    name: projectName,
    dueDate: collectedData.due_date_parsed ?? undefined,
    requester: requesterName,
    department: collectedData.requester_department ?? undefined,
    target: collectedData.target ?? undefined,
    contextBackground: collectedData.context_background ?? undefined,
    desiredOutcomes: collectedData.desired_outcomes ?? undefined,
    deliverables: collectedData.deliverables.length > 0 ? collectedData.deliverables : undefined,
    supportingLinks,
    approvals: collectedData.approvals ?? undefined,
    constraints: collectedData.constraints ?? undefined,
    deliverableType: deliverableClassification.label,
    ownerUserId,
    submissionLink: slackThreadLink,
  });

  return {
    ...result,
    unmatchedDeliverables: deliverableClassification.unmatched.length > 0 ? deliverableClassification.unmatched : undefined,
    deliverableTypeLabel: deliverableClassification.label,
  };
}

/**
 * Execute the post-approval workflow:
 * - Full projects: Generate brief → Create Drive folder → Save brief → Update Monday.com item
 * - Quick requests: Update Monday.com item status
 * - Both: Save project record to DB
 */
export async function executeApprovedWorkflow(opts: {
  collectedData: CollectedData;
  classification: 'quick' | 'full';
  requesterName: string;
  requesterSlackId: string;
  mondayItemId: string;
  source?: 'conversation' | 'form';
}): Promise<WorkflowResult> {
  const { collectedData, classification, requesterName, requesterSlackId, mondayItemId, source } = opts;
  const errors: string[] = [];

  const projectName = generateProjectName(collectedData);

  let briefDocUrl: string | undefined;
  let folderUrl: string | undefined;

  if (classification === 'full') {
    // Step 1: Allocate MKT project number (must happen first so brief can include it)
    let projectNumber: string | undefined;
    try {
      projectNumber = await allocateNextMktNumber();
      console.log(`[workflow] Allocated project number: ${projectNumber}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] MKT number allocation failed:', message);
      errors.push('MKT number allocation failed');
    }

    // Step 2: Generate brief (now includes the MKT number in the header)
    let briefMarkdown: string | undefined;
    try {
      briefMarkdown = await generateBrief(collectedData, classification, requesterName, projectNumber);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Brief generation failed:', message);
      errors.push('Brief generation failed');
    }

    // Step 3: Create Drive folder/doc
    let driveResult: DriveResult = { success: false };
    if (briefMarkdown && projectNumber) {
      try {
        driveResult = await createFullProjectDrive(projectName, briefMarkdown, projectNumber);
        if (driveResult.success) {
          briefDocUrl = driveResult.docUrl;
          folderUrl = driveResult.folderUrl;
        } else {
          errors.push(driveResult.error ?? 'Google Drive creation failed');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[workflow] Drive creation failed:', message);
        errors.push('Google Drive creation failed');
      }
    }

    // Step 4: Update Monday.com item — status + supporting links with Drive folder URL
    try {
      const columnUpdates: Record<string, unknown> = {
        [MONDAY_COLUMNS.status]: { label: 'Working on it' },
      };
      if (folderUrl) {
        // Append Drive folder link to supporting links column
        columnUpdates[MONDAY_COLUMNS.supportingLinks] = { text: `Project folder: ${folderUrl}` };
      }
      await updateMondayItemColumns(mondayItemId, columnUpdates);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Monday.com update failed:', message);
      errors.push('Monday.com update failed');
    }

    // Step 5: Post follow-up details as a Monday.com update/comment
    try {
      const additionalDetails = collectedData.additional_details ?? {};
      const detailEntries = Object.entries(additionalDetails)
        .filter(([key]) => !key.startsWith('__'))
        .filter(([, value]) => value && value.trim() !== '');

      if (detailEntries.length > 0) {
        const detailLines = detailEntries.map(([key, value]) => {
          const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          return `• ${label}: ${value}`;
        });
        const updateBody = `Follow-up details from intake:\n\n${detailLines.join('\n')}`;
        await addMondayItemUpdate(mondayItemId, updateBody);
      }
    } catch (err) {
      console.error('[workflow] Failed to post follow-up details to Monday.com:', err);
      // Non-critical — don't add to errors
    }
  } else {
    // Quick request — just update status
    try {
      await updateMondayItemStatus(mondayItemId, 'Working on it');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Monday.com status update failed:', message);
      errors.push('Monday.com status update failed');
    }
  }

  // Step 4: Save project record to DB
  let projectId: number | undefined;
  const mondayUrl = buildMondayUrl(mondayItemId);
  try {
    projectId = await createProject({
      name: projectName,
      type: classification,
      requester_name: requesterName,
      requester_slack_id: requesterSlackId,
      division: collectedData.requester_department,
      status: 'new',
      drive_folder_url: folderUrl ?? null,
      brief_doc_url: briefDocUrl ?? null,
      monday_item_id: mondayItemId,
      monday_url: mondayUrl,
      source: source ?? 'conversation',
      due_date: collectedData.due_date_parsed ?? collectedData.due_date,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[workflow] Project DB save failed:', message);
    errors.push('Failed to save project record');
  }

  return {
    success: errors.length === 0,
    briefDocUrl,
    folderUrl,
    mondayUrl,
    mondayItemId,
    projectId,
    errors,
  };
}

// --- Message formatting ---

/**
 * Build the Slack completion message from workflow results.
 * Always returns the success message — errors are routed to triage only, never shown to requesters.
 */
export function buildCompletionMessage(
  _result: WorkflowResult,
  _classification: 'quick' | 'full',
): string {
  return [
    `:tada: *All set! Your request has been approved and is now in progress.*`,
    '',
    'The marketing team has been notified and will begin working on your request.',
    'Reply to me anytime to check on status.',
    '',
    '_I\'m your intake assistant — the marketing team will take it from here!_',
  ].join('\n');
}
