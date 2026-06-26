/**
 * Google Sheet — the spoke's system of record (time-series data layer).
 *
 * Tabs:
 *   Data         — flat metric rows: runDate | competitor | metric | value | notes
 *   AI Visibility— per-prompt brand citations each week (share of voice)
 *   Synthesis    — one row per week: runDate | analystTake | pillarNotes
 *   Suggested    — competitors the spoke proposes adding (for Kat's approval)
 *
 * The deck reads from here; period-over-period comparisons live here.
 * If COMPETITOR_INTEL_SHEET_ID is unset, a new Sheet is created in the folder
 * and its id is logged for you to add to Railway.
 */

import { google } from 'googleapis';
import { getGoogleAuth } from './google-auth';
import { ciConfig } from '../config';
import type {
  AiVisibilityResult,
  ProposedCompetitor,
  SemrushSnapshot,
  WeeklySynthesis,
} from '../types';

const TABS = ['Data', 'AI Visibility', 'Synthesis', 'Suggested', 'Events'] as const;
const HEADERS: Record<(typeof TABS)[number], string[]> = {
  Data: ['Run Date', 'Competitor', 'Metric', 'Value', 'Notes'],
  'AI Visibility': ['Run Date', 'Prompt', 'Engine', 'Brands Cited (in order)', 'Pearl Present', 'Citation Domains'],
  Synthesis: ['Run Date', 'Analyst Take', 'Pillar Notes', 'Top Movements'],
  Suggested: ['Run Date', 'Name', 'Category', 'Reason', 'Source'],
  Events: ['Detected', 'Competitor', 'Category', 'Headline', 'Why It Matters', 'Source', 'Dedup Key'],
};

function sheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() });
}
function driveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuth() });
}

/** Return the sheet id, creating + initializing the spreadsheet if needed. */
export async function ensureSheet(): Promise<string> {
  if (ciConfig.sheetId) {
    await ensureTabs(ciConfig.sheetId);
    return ciConfig.sheetId;
  }
  // Create in the configured folder
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: {
      name: 'Pearl Competitor Intelligence — Data',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [ciConfig.folderId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  const id = res.data.id!;
  await ensureTabs(id);
  console.log(
    `[sheet] Created data Sheet ${id}. Add COMPETITOR_INTEL_SHEET_ID=${id} to Railway to reuse it.`,
  );
  return id;
}

async function ensureTabs(sheetId: string): Promise<void> {
  const sheets = sheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));

  const toAdd = TABS.filter((t) => !existing.has(t));
  if (toAdd.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: toAdd.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    // Write header rows for new tabs
    for (const title of toAdd) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${title}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADERS[title]] },
      });
    }
  }
}

async function append(sheetId: string, tab: string, rows: (string | number)[][]) {
  if (!rows.length) return;
  await sheetsClient().spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/** Write everything from one weekly run. */
export async function writeWeek(
  sheetId: string,
  runDate: string,
  data: { semrush: SemrushSnapshot[]; aiVisibility: AiVisibilityResult[] },
  synthesis: WeeklySynthesis,
): Promise<void> {
  // Data tab — quantitative metrics
  const dataRows: (string | number)[][] = [];
  for (const s of data.semrush) {
    if (s.error) {
      dataRows.push([runDate, s.domain, 'semrush_error', s.error, '']);
      continue;
    }
    dataRows.push([runDate, s.domain, 'organic_keywords', s.organicKeywords ?? '', '']);
    dataRows.push([runDate, s.domain, 'organic_traffic', s.organicTraffic ?? '', '']);
    dataRows.push([runDate, s.domain, 'adwords_keywords', s.adwordsKeywords ?? '', '']);
  }
  await append(sheetId, 'Data', dataRows);

  // AI Visibility tab
  await append(
    sheetId,
    'AI Visibility',
    data.aiVisibility.map((a) => [
      runDate,
      a.prompt,
      a.engine,
      a.mentionedBrands.join(' > '),
      a.pearlMentioned ? 'YES' : 'no',
      a.citationDomains.join(', '),
    ]),
  );

  // Synthesis tab
  await append(sheetId, 'Synthesis', [
    [runDate, synthesis.analystTake, synthesis.pillarNotes, synthesis.movements.join(' | ')],
  ]);

  // Suggested tab
  await append(
    sheetId,
    'Suggested',
    synthesis.suggestedAdditions.map((p: ProposedCompetitor) => [
      runDate,
      p.name,
      p.category,
      p.reason,
      p.source ?? '',
    ]),
  );
}

/** Dedup keys of events already alerted (so the pulse never repeats an alert). */
export async function readSeenEventKeys(sheetId: string): Promise<Set<string>> {
  try {
    const res = await sheetsClient().spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Events!G2:G',
    });
    return new Set((res.data.values ?? []).map((r) => r[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Append newly-detected material events to the Events log. */
export async function appendEvents(
  sheetId: string,
  detected: string,
  events: import('../types').MaterialEvent[],
): Promise<void> {
  await append(
    sheetId,
    'Events',
    events.map((e) => [detected, e.competitor, e.category, e.headline, e.why, e.source, e.dedupKey]),
  );
}

/** Last recorded AI-visibility brand list per prompt (baseline for shift detection). */
export async function readLatestAiVisibility(sheetId: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  try {
    const res = await sheetsClient().spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'AI Visibility!B2:D', // Prompt | Engine | Brands Cited (in order)
    });
    for (const row of res.data.values ?? []) {
      const prompt = row[0];
      const brands = (row[2] ?? '').split('>').map((s: string) => s.trim()).filter(Boolean);
      if (prompt) map.set(prompt, brands); // later rows overwrite -> latest wins
    }
  } catch {
    /* no baseline yet */
  }
  return map;
}

/** Most recent analyst take (for "what changed" context next run). */
export async function readLatestTake(sheetId: string): Promise<string | undefined> {
  try {
    const res = await sheetsClient().spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Synthesis!B2:B',
    });
    const vals = res.data.values ?? [];
    return vals.length ? vals[vals.length - 1][0] : undefined;
  } catch {
    return undefined;
  }
}
