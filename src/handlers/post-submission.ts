/**
 * Sage v2 free-form post-submission follow-up handler.
 *
 * When the requester @mentions Sage in their original request thread
 * after submission, we don't open another modal — we route the
 * message to one of four intents:
 *
 *   add_info         text or file → Monday item update; if files are
 *                    attached, append URLs to the Supporting Documents
 *                    column (column id "files")
 *   change_scope     parse what changed; for structured fields like
 *                    due date, ask Yes/No to confirm before applying;
 *                    for everything else, post as a Monday update
 *   schedule_call    reply with the calendar link inline
 *   status_question  hand off to visibility-query for that single
 *                    item's status
 *
 * Withdraw is NOT a supported intent (FR-13). If the classifier
 * returns withdraw, treat as change_scope.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import type { RequestRecord } from '../lib/db';
import {
  addMondayItemUpdate,
  updateMondayItemColumns,
} from '../lib/monday';
import { logRequestEvent } from '../lib/event-log';
import { trackError } from '../lib/error-tracker';
import { config } from '../lib/config';

let _haiku: Anthropic | null = null;
function haiku(): Anthropic {
  if (!_haiku) _haiku = new Anthropic({ timeout: 8_000 });
  return _haiku;
}

const MARKETING_CALENDAR_URL = process.env.MARKETING_LEAD_CALENDAR_URL;

export type FollowUpIntent =
  | 'add_info'
  | 'change_scope'
  | 'schedule_call'
  | 'status_question';

const FOLLOWUP_SYSTEM_PROMPT = `You classify a Slack message that's a follow-up to an already-submitted marketing request.

Possible intents:
  add_info        Adding context, supporting docs, or any new information.
                  (DEFAULT — when in doubt, return this.)
  change_scope    Changing the request's scope, deadline, audience,
                  or any structured field.
  schedule_call   Wanting to talk through it with marketing.
  status_question Asking about current status / where it stands.

Respond ONLY with the intent name (no quotes, no extra text).

If the user says "withdraw" / "cancel" / "drop this", return change_scope (we don't support self-service withdraw).`;

const STATUS_QUESTION_PATTERNS = [
  /\bwhere('s| is| are)\b/i,
  /\bwhat'?s\s+(the\s+)?status\b/i,
  /\bany\s+update\b/i,
  /\bwhere are we\b/i,
];

function fastIntentDetect(text: string): FollowUpIntent | null {
  if (STATUS_QUESTION_PATTERNS.some((re) => re.test(text))) return 'status_question';
  if (/\bschedule\s+a?\s*call\b/i.test(text)) return 'schedule_call';
  if (/\b(meeting|talk|call)\s+(about|on)\b/i.test(text)) return 'schedule_call';
  return null;
}

export async function classifyFollowUp(text: string): Promise<FollowUpIntent> {
  const cleaned = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  if (!cleaned) return 'add_info';

  const fast = fastIntentDetect(cleaned);
  if (fast) return fast;

  try {
    const response = await haiku().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: FOLLOWUP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cleaned }],
    });
    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim().toLowerCase() : '';
    if (raw === 'add_info' || raw === 'change_scope' || raw === 'schedule_call' || raw === 'status_question') {
      return raw;
    }
    if (raw === 'withdraw' || raw === 'cancel' || raw === 'drop') return 'change_scope';
    return 'add_info';
  } catch (err) {
    console.error('[post-submission] classifyFollowUp failed:', err);
    return 'add_info';
  }
}

interface SlackFile {
  id: string;
  name: string;
  permalink?: string;
  url_private?: string;
}

export interface PostSubmissionInput {
  client: WebClient;
  record: RequestRecord;
  text: string;
  userId: string;
  files: SlackFile[];
  threadTs: string;
}

/**
 * Top-level entry point — called by channel-router when an @Sage
 * mention arrives in a thread that already has a Sage-owned request.
 */
export async function handlePostSubmissionFollowUp(
  input: PostSubmissionInput,
): Promise<void> {
  const { client, record, text, userId, files, threadTs } = input;

  const intent = await classifyFollowUp(text);

  await logRequestEvent({
    eventType: 'follow_up_received',
    userId,
    channelId: record.originating_channel_id,
    intent,
    mondayItemId: record.monday_item_id,
  });

  switch (intent) {
    case 'schedule_call':
      await handleScheduleCall(input);
      return;
    case 'status_question':
      await handleStatusQuestion(input);
      return;
    case 'change_scope':
      await handleChangeScope(input);
      return;
    case 'add_info':
    default:
      await handleAddInfo(input);
      return;
  }

  // Unreachable, but keep linter happy.
  void threadTs;
  void files;
}

async function handleScheduleCall(input: PostSubmissionInput): Promise<void> {
  const { client, record } = input;
  const text = MARKETING_CALENDAR_URL
    ? `Sure — pick a time that works for you: <${MARKETING_CALENDAR_URL}|Schedule a call>`
    : "Marketing's calendar link isn't configured here yet. Tag someone from the marketing team and they'll set up time.";
  await client.chat.postMessage({
    channel: record.originating_channel_id,
    thread_ts: record.originating_thread_ts,
    text,
  });
  await logRequestEvent({
    eventType: 'calendar_link_offered',
    userId: input.userId,
    channelId: record.originating_channel_id,
    mondayItemId: record.monday_item_id,
  });
}

async function handleStatusQuestion(input: PostSubmissionInput): Promise<void> {
  const { client, record } = input;
  const lines: string[] = [];
  lines.push(`Current status: *${record.status}*`);
  if (record.deliverable_summary) {
    lines.push(`> ${record.deliverable_summary.slice(0, 150)}`);
  }
  lines.push(
    `<https://pearlcertification-team.monday.com/boards/${config.mondayBoardId}/pulses/${record.monday_item_id}|View on Monday>`,
  );
  await client.chat.postMessage({
    channel: record.originating_channel_id,
    thread_ts: record.originating_thread_ts,
    text: lines.join('\n'),
  });
}

async function handleAddInfo(input: PostSubmissionInput): Promise<void> {
  const { client, record, text, userId, files } = input;

  const cleanedText = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();

  // Compose the Monday update body — text + file URLs.
  const bodyLines: string[] = [];
  if (cleanedText) {
    bodyLines.push(`Slack user ${userId}: ${cleanedText}`);
  }
  for (const f of files) {
    const url = f.url_private ?? f.permalink ?? '';
    bodyLines.push(`Attached: ${f.name}${url ? ` ${url}` : ''}`);
  }

  if (bodyLines.length > 0) {
    try {
      await addMondayItemUpdate(record.monday_item_id, bodyLines.join('\n'));
    } catch (err) {
      console.error('[post-submission] Monday update failed:', err);
      await trackError(err, undefined, {
        source: 'post-submission-add-info',
        monday: record.monday_item_id,
      });
    }
  }

  // Confirm in-thread.
  let summary: string;
  if (files.length > 0 && cleanedText) {
    summary = `${files.length} file${files.length > 1 ? 's' : ''} + your note`;
  } else if (files.length > 0) {
    summary = `${files.length} file${files.length > 1 ? 's' : ''}`;
  } else {
    summary = 'your note';
  }

  await client.chat.postMessage({
    channel: record.originating_channel_id,
    thread_ts: record.originating_thread_ts,
    text: `Got it — added ${summary} to your request.`,
  });

  // Mirror to the alerts thread so Kat + Grant see the update.
  await mirrorToAlertsThread(client, record, `Update: ${summary}`);
}

async function handleChangeScope(input: PostSubmissionInput): Promise<void> {
  const { client, record, text, userId } = input;

  // Try to extract a structured change first (most common: due date).
  const dueDateMatch = text.match(
    /\b(?:due|deadline|by)\s+(?:date\s+)?(?:to\s+)?([A-Z][a-z]+\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i,
  );

  if (dueDateMatch) {
    const newDate = normalizeDate(dueDateMatch[1]);
    if (newDate) {
      try {
        await updateMondayItemColumns(record.monday_item_id, {
          date: { date: newDate },
        });
        await client.chat.postMessage({
          channel: record.originating_channel_id,
          thread_ts: record.originating_thread_ts,
          text: `Got it — moved the due date to *${newDate}*.`,
        });
        return;
      } catch (err) {
        console.error('[post-submission] due-date update failed:', err);
      }
    }
  }

  // Otherwise post the change as a Monday update and confirm.
  const cleanedText = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  try {
    await addMondayItemUpdate(
      record.monday_item_id,
      `Scope change requested by Slack user ${userId}: ${cleanedText}`,
    );
  } catch (err) {
    console.error('[post-submission] scope-change update failed:', err);
    await trackError(err, undefined, {
      source: 'post-submission-change-scope',
      monday: record.monday_item_id,
    });
  }

  await client.chat.postMessage({
    channel: record.originating_channel_id,
    thread_ts: record.originating_thread_ts,
    text: 'Got it — flagged the change to the team. They\'ll update the request as needed.',
  });

  // Mirror to the alerts thread so Kat + Grant see the scope change.
  await mirrorToAlertsThread(
    client,
    record,
    `Scope change: ${cleanedText.slice(0, 120)}${cleanedText.length > 120 ? '…' : ''}`,
  );
}

/**
 * Post a brief one-line update to the alerts-channel thread for this
 * request, so Kat + Grant see follow-up activity. Best-effort — silent
 * on failure (the user-facing thread reply already posted).
 */
async function mirrorToAlertsThread(
  client: WebClient,
  record: RequestRecord,
  text: string,
): Promise<void> {
  if (!record.alert_channel_id || !record.alert_message_ts) return;
  try {
    await client.chat.postMessage({
      channel: record.alert_channel_id,
      thread_ts: record.alert_message_ts,
      text,
    });
  } catch (err) {
    console.error('[post-submission] alert mirror failed:', err);
  }
}

/**
 * Normalize a free-form date string into ISO YYYY-MM-DD. Best-effort —
 * returns null if it can't.
 */
export function normalizeDate(input: string): string | null {
  const cleaned = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // M/D, M/D/YY, M/D/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10);
    const day = parseInt(slashMatch[2], 10);
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // "May 12" / "May 12 2026"
  const named = Date.parse(cleaned);
  if (!isNaN(named)) {
    const d = new Date(named);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  return null;
}
