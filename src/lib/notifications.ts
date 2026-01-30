import type { CollectedData } from './conversation';
import type { WorkflowResult } from './workflow';

// --- Types ---

export interface NotificationParams {
  projectName: string;
  classification: 'quick' | 'full';
  collectedData: CollectedData;
  requesterName: string;
  result: WorkflowResult;
}

export interface TriageMessageParams {
  projectName: string;
  classification: 'quick' | 'full';
  collectedData: CollectedData;
  requesterName: string;
  result: WorkflowResult;
}

// --- Public API ---

/**
 * Build a formatted notification message for the #marketing-requests channel.
 * Quick requests use a compact format; full projects include a deliverables list.
 */
export function buildNotificationMessage(params: NotificationParams): string {
  const { projectName, classification, collectedData, requesterName, result } = params;

  if (classification === 'quick') {
    return buildQuickNotification(projectName, collectedData, requesterName, result);
  }
  return buildFullNotification(projectName, collectedData, requesterName, result);
}

// --- Private helpers ---

function buildQuickNotification(
  projectName: string,
  data: CollectedData,
  requesterName: string,
  result: WorkflowResult,
): string {
  const lines: string[] = [
    `:inbox_tray: *Quick Request: ${projectName}*`,
    '',
    `• *From:* ${requesterName}`,
  ];

  if (data.requester_department) {
    lines.push(`• *Department:* ${data.requester_department}`);
  }
  if (data.target) {
    lines.push(`• *Target:* ${data.target}`);
  }
  if (data.due_date) {
    lines.push(`• *Due:* ${data.due_date}`);
  }
  if (data.context_background) {
    lines.push(`• *Summary:* ${data.context_background}`);
  }

  lines.push('');
  appendLinks(lines, result);

  lines.push('');
  lines.push('React with :eyes: to claim this request');

  return lines.join('\n');
}

function buildFullNotification(
  projectName: string,
  data: CollectedData,
  requesterName: string,
  result: WorkflowResult,
): string {
  const lines: string[] = [
    `:inbox_tray: *New Project: ${projectName}*`,
    '',
    `• *From:* ${requesterName}`,
  ];

  if (data.requester_department) {
    lines.push(`• *Department:* ${data.requester_department}`);
  }
  if (data.target) {
    lines.push(`• *Target:* ${data.target}`);
  }
  if (data.due_date) {
    lines.push(`• *Due:* ${data.due_date}`);
  }
  if (data.context_background) {
    lines.push(`• *Summary:* ${data.context_background}`);
  }

  if (data.deliverables.length > 0) {
    lines.push('');
    lines.push('*Deliverables:*');
    for (const d of data.deliverables) {
      lines.push(`  • ${d}`);
    }
  }

  lines.push('');
  appendLinks(lines, result);

  lines.push('');
  lines.push('React with :eyes: to claim this request');

  return lines.join('\n');
}

function appendLinks(lines: string[], result: WorkflowResult): void {
  if (result.briefDocUrl) {
    lines.push(`• *Brief:* <${result.briefDocUrl}|View brief>`);
  }
  if (result.folderUrl) {
    lines.push(`• *Drive folder:* <${result.folderUrl}|Open folder>`);
  }
  if (result.mondayUrl) {
    lines.push(`• *Monday.com:* <${result.mondayUrl}|View task>`);
  }
}

/**
 * Build a triage DM for the marketing lead.
 * Includes: brief link, who requested, level of effort, one-sentence description.
 */
export function buildTriageMessage(params: TriageMessageParams): string {
  const { projectName, classification, collectedData, requesterName, result } = params;

  const levelOfEffort = classification === 'quick' ? 'Quick Request' : 'Full Project';

  const description = collectedData.context_background ?? 'No description provided';
  // Take just the first sentence or first 120 chars
  const oneLiner = description.includes('.')
    ? description.split('.')[0] + '.'
    : description.slice(0, 120);

  const lines: string[] = [
    `:incoming_envelope: *New ${levelOfEffort} for Triage: ${projectName}*`,
    '',
    `• *Requested by:* ${requesterName}`,
    `• *Level of effort:* ${levelOfEffort}`,
    `• *Summary:* ${oneLiner}`,
  ];

  if (collectedData.target) {
    lines.push(`• *Target:* ${collectedData.target}`);
  }
  if (collectedData.due_date) {
    lines.push(`• *Due:* ${collectedData.due_date}`);
  }

  lines.push('');

  // Include internal links for the marketing lead
  if (result.briefDocUrl) {
    lines.push(`• <${result.briefDocUrl}|View Operational Brief>`);
  }
  if (result.folderUrl) {
    lines.push(`• <${result.folderUrl}|Open Project Folder>`);
  }
  if (result.mondayUrl) {
    lines.push(`• <${result.mondayUrl}|View on Monday.com>`);
  }

  return lines.join('\n');
}
