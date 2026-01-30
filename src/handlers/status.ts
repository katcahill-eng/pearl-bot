import type { SayFn } from '@slack/bolt';
import { config } from '../lib/config';
import { searchProjects, type Project } from '../lib/db';
import { searchItems, type MondaySearchResult } from '../lib/monday';

/**
 * Handle a status check request.
 * Searches both local DB and Monday.com for matching projects.
 */
export async function handleStatusCheck(opts: {
  text: string;
  threadTs: string;
  say: SayFn;
}): Promise<void> {
  const { text, threadTs, say } = opts;

  const query = extractSearchQuery(text);

  if (!query) {
    await say({
      text: [
        ":mag: I'd be happy to check on a project for you!",
        '',
        'Try asking something like:',
        '• "Status of the Q1 newsletter"',
        '• "Where are we on the rebrand project?"',
        '• "Update on conference materials"',
      ].join('\n'),
      thread_ts: threadTs,
    });
    return;
  }

  // Search both local DB and Monday.com in parallel
  const [localResults, mondayResults] = await Promise.all([
    safeSearchLocal(query),
    safeSearchMonday(query),
  ]);

  // Merge and deduplicate results (prefer Monday data when both exist)
  const merged = mergeResults(localResults, mondayResults);

  if (merged.length === 0) {
    await say({
      text: [
        `:mag: I couldn't find a project matching "${query}".`,
        '',
        'A few things to try:',
        '• Use different keywords',
        `• Check <#${config.slackMarketingChannelId}> for recent requests`,
        '• Tag someone from the marketing team in #marcoms-requests for older projects',
      ].join('\n'),
      thread_ts: threadTs,
    });
    return;
  }

  if (merged.length === 1) {
    await say({
      text: formatStatusResponse(merged[0]),
      thread_ts: threadTs,
    });
    return;
  }

  // Multiple matches — ask user to pick
  const list = merged
    .slice(0, 5)
    .map((r, i) => `${i + 1}. *${r.name}*${r.status ? ` — ${r.status}` : ''}`)
    .join('\n');

  await say({
    text: [
      `:mag: I found ${merged.length} projects matching "${query}":`,
      '',
      list,
      '',
      'Which one did you mean? Reply with the number or a more specific name.',
    ].join('\n'),
    thread_ts: threadTs,
  });
}

// --- Helpers ---

interface MergedResult {
  name: string;
  status?: string;
  assignee?: string;
  dueDate?: string;
  updatedAt?: string;
  briefDocUrl?: string;
  driveFolderUrl?: string;
  mondayUrl?: string;
}

function extractSearchQuery(rawText: string): string | null {
  // Strip bot mention
  let text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  // Remove common status prefixes
  const prefixes = [
    /^status\s+of\s+/i,
    /^where\s+are\s+we\s+on\s+/i,
    /^update\s+on\s+/i,
    /^what'?s?\s+the\s+progress\s+(of|on)\s+/i,
    /^status\s+/i,
    /^check\s+on\s+/i,
    /^check\s+status\s+of\s+/i,
  ];

  for (const prefix of prefixes) {
    text = text.replace(prefix, '');
  }

  // Remove leading articles
  text = text.replace(/^(the|a|an)\s+/i, '').trim();

  // Remove surrounding quotes
  text = text.replace(/^["']|["']$/g, '').trim();

  return text.length > 0 ? text : null;
}

async function safeSearchLocal(query: string): Promise<Project[]> {
  try {
    return searchProjects(query);
  } catch (err) {
    console.error('[status] Local search failed:', err);
    return [];
  }
}

async function safeSearchMonday(query: string): Promise<MondaySearchResult[]> {
  try {
    return await searchItems(query);
  } catch (err) {
    console.error('[status] Monday.com search failed:', err);
    return [];
  }
}

function mergeResults(
  local: Project[],
  monday: MondaySearchResult[],
): MergedResult[] {
  const results: MergedResult[] = [];
  const seenNames = new Set<string>();

  // Add Monday results first (they have live status data)
  for (const item of monday) {
    const key = item.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    // Try to find a matching local project for additional links
    const localMatch = local.find(
      (p) => p.name.toLowerCase() === key || p.monday_item_id === item.id,
    );

    results.push({
      name: item.name,
      status: item.status,
      assignee: item.assignee,
      dueDate: item.dueDate,
      updatedAt: item.updatedAt,
      briefDocUrl: localMatch?.brief_doc_url ?? undefined,
      driveFolderUrl: localMatch?.drive_folder_url ?? undefined,
      mondayUrl: item.boardUrl,
    });
  }

  // Add local-only results (not already covered by Monday)
  for (const project of local) {
    const key = project.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    results.push({
      name: project.name,
      status: project.status,
      dueDate: project.due_date ?? undefined,
      briefDocUrl: project.brief_doc_url ?? undefined,
      driveFolderUrl: project.drive_folder_url ?? undefined,
      mondayUrl: project.monday_url ?? undefined,
    });
  }

  return results;
}

function formatStatusResponse(result: MergedResult): string {
  const lines: string[] = [`:clipboard: *${result.name}*`, ''];

  if (result.status) {
    lines.push(`*Status:* ${result.status}`);
  }
  if (result.assignee) {
    lines.push(`*Assignee:* ${result.assignee}`);
  }
  if (result.dueDate) {
    lines.push(`*Due date:* ${result.dueDate}`);
  }
  if (result.updatedAt) {
    lines.push(`*Last updated:* ${result.updatedAt}`);
  }

  // Links section
  const links: string[] = [];
  if (result.briefDocUrl) {
    links.push(`<${result.briefDocUrl}|Brief>`);
  }
  if (result.driveFolderUrl) {
    links.push(`<${result.driveFolderUrl}|Drive Folder>`);
  }
  if (result.mondayUrl) {
    links.push(`<${result.mondayUrl}|Monday.com>`);
  }

  if (links.length > 0) {
    lines.push('');
    lines.push(`*Links:* ${links.join(' · ')}`);
  }

  return lines.join('\n');
}
