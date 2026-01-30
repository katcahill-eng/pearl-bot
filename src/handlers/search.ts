import type { SayFn } from '@slack/bolt';
import { config } from '../lib/config';
import { searchProjects, type Project } from '../lib/db';
import { searchItems, type MondaySearchResult } from '../lib/monday';

/**
 * Handle a search/retrieval request.
 * Searches both local DB and Monday.com for matching projects and returns links.
 */
export async function handleSearchRequest(opts: {
  text: string;
  threadTs: string;
  say: SayFn;
}): Promise<void> {
  const { text, threadTs, say } = opts;

  const query = extractSearchQuery(text);

  if (!query) {
    await say({
      text: [
        ":mag: I can help you find a brief or project link!",
        '',
        'Try asking something like:',
        '• "Find the brief for Q1 newsletter"',
        '• "Link to the rebrand project"',
        '• "Where\'s the conference materials folder?"',
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

  // Merge and deduplicate results
  const merged = mergeResults(localResults, mondayResults);

  if (merged.length === 0) {
    await say({
      text: [
        `:mag: I couldn't find a project matching "${query}".`,
        '',
        "I can only find projects created through me. For older projects, check Monday.com or Google Drive directly.",
        '',
        'A few things to try:',
        '• Use different keywords',
        `• Check <#${config.slackMarketingChannelId}> for recent requests`,
        '• Ask in #marketing-team for older projects',
      ].join('\n'),
      thread_ts: threadTs,
    });
    return;
  }

  if (merged.length === 1) {
    await say({
      text: formatSearchResponse(merged[0]),
      thread_ts: threadTs,
    });
    return;
  }

  // Multiple matches — ask user to pick
  const list = merged
    .slice(0, 5)
    .map((r, i) => `${i + 1}. *${r.name}*${r.type ? ` (${r.type})` : ''}`)
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

interface SearchResult {
  name: string;
  type?: string;
  briefDocUrl?: string;
  driveFolderUrl?: string;
  mondayUrl?: string;
}

function extractSearchQuery(rawText: string): string | null {
  // Strip bot mention
  let text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  // Remove common search prefixes
  const prefixes = [
    /^find\s+the\s+brief\s+for\s+/i,
    /^find\s+the\s+folder\s+for\s+/i,
    /^find\s+the\s+link\s+(to|for)\s+/i,
    /^find\s+the\s+project\s+/i,
    /^find\s+/i,
    /^link\s+to\s+(the\s+)?/i,
    /^where'?s?\s+the\s+(brief|folder|link|project)\s+(for\s+)?/i,
    /^where'?s?\s+the\s+/i,
    /^get\s+(me\s+)?(the\s+)?(link|brief|folder)\s+(to|for)\s+/i,
    /^get\s+(me\s+)?/i,
    /^show\s+(me\s+)?(the\s+)?/i,
  ];

  for (const prefix of prefixes) {
    text = text.replace(prefix, '');
  }

  // Remove trailing keywords like "brief", "folder", "link" that are part of the search phrase
  text = text.replace(/\s+(brief|folder|link|project)$/i, '');

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
    console.error('[search] Local search failed:', err);
    return [];
  }
}

async function safeSearchMonday(query: string): Promise<MondaySearchResult[]> {
  try {
    return await searchItems(query);
  } catch (err) {
    console.error('[search] Monday.com search failed:', err);
    return [];
  }
}

function mergeResults(
  local: Project[],
  monday: MondaySearchResult[],
): SearchResult[] {
  const results: SearchResult[] = [];
  const seenNames = new Set<string>();

  // Add Monday results first (they have live data)
  for (const item of monday) {
    const key = item.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    // Try to find a matching local project for links
    const localMatch = local.find(
      (p) => p.name.toLowerCase() === key || p.monday_item_id === item.id,
    );

    results.push({
      name: item.name,
      type: localMatch?.type ?? undefined,
      briefDocUrl: localMatch?.brief_doc_url ?? undefined,
      driveFolderUrl: localMatch?.drive_folder_url ?? undefined,
      mondayUrl: item.boardUrl,
    });
  }

  // Add local-only results
  for (const project of local) {
    const key = project.name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    results.push({
      name: project.name,
      type: project.type,
      briefDocUrl: project.brief_doc_url ?? undefined,
      driveFolderUrl: project.drive_folder_url ?? undefined,
      mondayUrl: project.monday_url ?? undefined,
    });
  }

  return results;
}

function formatSearchResponse(result: SearchResult): string {
  const lines: string[] = [`:link: *${result.name}*`, ''];

  const links: string[] = [];
  if (result.briefDocUrl) {
    links.push(`<${result.briefDocUrl}|:page_facing_up: Brief>`);
  }
  if (result.driveFolderUrl) {
    links.push(`<${result.driveFolderUrl}|:file_folder: Drive Folder>`);
  }
  if (result.mondayUrl) {
    links.push(`<${result.mondayUrl}|:calendar: Monday.com>`);
  }

  if (links.length > 0) {
    lines.push('*Links:*');
    for (const link of links) {
      lines.push(`• ${link}`);
    }
  } else {
    lines.push("I found this project but don't have any links saved for it.");
    lines.push('It may have been created before I started tracking projects.');
  }

  return lines.join('\n');
}
