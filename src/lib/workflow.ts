import { config } from './config';
import type { CollectedData } from './conversation';
import type { RequestClassification } from './claude';
import { generateBrief } from './brief-generator';
import { createFullProjectDrive, type DriveResult } from './google-drive';
import { createQuickRequestItem, createFullProjectItem, updateMondayItemStatus, updateMondayItemColumns, FULL_BOARD_STATUS_COLUMN, FULL_BOARD_FOLDER_LINK_COLUMN, type MondayResult } from './monday';
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
 * Item is created with "Under Review" status on the correct board/group.
 */
export async function createMondayItemForReview(opts: {
  collectedData: CollectedData;
  classification: 'quick' | 'full';
  requesterName: string;
}): Promise<MondayResult> {
  const { collectedData, classification, requesterName } = opts;

  const projectName =
    collectedData.context_background?.slice(0, 80) ??
    collectedData.deliverables[0] ??
    'Untitled Request';

  if (classification === 'quick') {
    return createQuickRequestItem({
      name: projectName,
      dueDate: collectedData.due_date_parsed ?? undefined,
      requester: requesterName,
      department: collectedData.requester_department ?? undefined,
      target: collectedData.target ?? undefined,
      contextBackground: collectedData.context_background ?? undefined,
      desiredOutcomes: collectedData.desired_outcomes ?? undefined,
    });
  } else {
    return createFullProjectItem({
      name: projectName,
      deliverables: collectedData.deliverables,
      dueDate: collectedData.due_date_parsed ?? undefined,
      requester: requesterName,
      department: collectedData.requester_department ?? undefined,
      target: collectedData.target ?? undefined,
      contextBackground: collectedData.context_background ?? undefined,
      desiredOutcomes: collectedData.desired_outcomes ?? undefined,
    });
  }
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
  mondayBoardId: string;
  source?: 'conversation' | 'form';
}): Promise<WorkflowResult> {
  const { collectedData, classification, requesterName, requesterSlackId, mondayItemId, mondayBoardId, source } = opts;
  const errors: string[] = [];

  const projectName =
    collectedData.context_background?.slice(0, 80) ??
    collectedData.deliverables[0] ??
    'Untitled Request';

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

    // Step 3: Update Monday.com item — status + links (full board column IDs)
    try {
      const columnUpdates: Record<string, unknown> = {
        [FULL_BOARD_STATUS_COLUMN]: { label: 'Working on it' },
      };
      if (folderUrl) {
        columnUpdates[FULL_BOARD_FOLDER_LINK_COLUMN] = { url: folderUrl, text: 'Drive Folder' };
      }
      await updateMondayItemColumns(mondayItemId, mondayBoardId, columnUpdates);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Monday.com update failed:', message);
      errors.push('Monday.com update failed');
    }
  } else {
    // Quick request — just update status
    try {
      await updateMondayItemStatus(mondayItemId, mondayBoardId, 'Working on it');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[workflow] Monday.com status update failed:', message);
      errors.push('Monday.com status update failed');
    }
  }

  // Step 4: Save project record to DB
  let projectId: number | undefined;
  const mondayUrl = `https://pearl-certification.monday.com/boards/${mondayBoardId}/pulses/${mondayItemId}`;
  try {
    projectId = createProject({
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
