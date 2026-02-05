import { config } from './config';
import { generateProjectName, type CollectedData } from './conversation';
import type { RequestClassification } from './claude';
import { generateBrief } from './brief-generator';
import { createFullProjectDrive, type DriveResult } from './google-drive';
import { createRequestItem, updateMondayItemStatus, updateMondayItemColumns, buildMondayUrl, MONDAY_COLUMNS, type MondayResult } from './monday';
import { createProject } from './db';

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
export async function createMondayItemForReview(opts: {
  collectedData: CollectedData;
  classification: 'quick' | 'full';
  requesterName: string;
  channelId: string;
  threadTs: string;
}): Promise<MondayResult> {
  const { collectedData, requesterName, channelId, threadTs } = opts;

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

  return createRequestItem({
    name: projectName,
    dueDate: collectedData.due_date_parsed ?? undefined,
    requester: requesterName,
    department: collectedData.requester_department ?? undefined,
    target: collectedData.target ?? undefined,
    contextBackground: collectedData.context_background ?? undefined,
    desiredOutcomes: collectedData.desired_outcomes ?? undefined,
    deliverables: collectedData.deliverables.length > 0 ? collectedData.deliverables : undefined,
    supportingLinks,
    submissionLink: slackThreadLink,
  });
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
    // Step 1: Generate brief
    let briefMarkdown: string | undefined;
    try {
      briefMarkdown = await generateBrief(collectedData, classification, requesterName);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Brief generation failed:', message);
      errors.push('Brief generation failed');
    }

    // Step 2: Create Drive folder/doc
    let driveResult: DriveResult = { success: false };
    if (briefMarkdown) {
      try {
        driveResult = await createFullProjectDrive(projectName, briefMarkdown);
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

    // Step 3: Update Monday.com item — status + supporting links with Drive folder URL
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
 * Distinguishes infrastructure from work (UX spec constraint #10).
 */
export function buildCompletionMessage(
  result: WorkflowResult,
  classification: 'quick' | 'full',
): string {
  // Full success — requester does NOT see Drive links (those are internal to marketing)
  if (result.errors.length === 0) {
    const lines: string[] = [
      `:tada: *All set! Your request has been approved and is now in progress.*`,
      '',
      'The marketing team has been notified and will begin working on your request.',
      'Reply to me anytime to check on status.',
      '',
      '_I\'m your intake assistant — the marketing team will take it from here!_',
    ];

    return lines.join('\n');
  }

  // Partial failure — still no Drive links for requesters
  const lines: string[] = [
    `:warning: *Your request was approved, but some setup steps had issues:*`,
    '',
  ];

  // Show what failed (without exposing internal links)
  for (const error of result.errors) {
    lines.push(`• :x: ${error}`);
  }

  lines.push('');
  lines.push('Your information has been saved. The marketing team has been notified and can set up anything that failed manually.');

  if (config.intakeFormUrl) {
    lines.push(`You can also submit via the intake form as a backup: ${config.intakeFormUrl}`);
  }

  lines.push('If you need immediate help, tag someone from the marketing team in #marcoms-requests.');

  return lines.join('\n');
}
