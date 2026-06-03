/**
 * Sage v2 visibility query handler.
 *
 * Resolves @Sage status_query mentions like "where's my request",
 * "what's open in BD", "what BD requests are stuck" into a Monday
 * query and renders a thread reply with up to 10 items inline.
 *
 * Per PRD US-008:
 *   - In an intake channel, scope: 'division' defaults to that
 *     channel's division.
 *   - In the alerts channel, scope: 'pearl-wide' is the default
 *     so marketing leads see across divisions.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  divisionForChannel,
  type Division,
  type ChannelRole,
} from '../lib/division-lookup';
import { formatItemAttribution } from '../lib/format-monday-item';
import {
  getRequestByThread,
  getRequestsByUser,
  getRequestsByDivision,
  getAllOpenRequests,
  type RequestRecord,
} from '../lib/db';
import { buildMondayUrl } from '../lib/monday';
import { config } from '../lib/config';

let _haiku: Anthropic | null = null;
function haiku(): Anthropic {
  if (!_haiku) _haiku = new Anthropic({ timeout: 8_000 });
  return _haiku;
}

const QUERY_SYSTEM_PROMPT = `You parse a single Slack user query about marketing-request status into a structured spec.

Respond ONLY with a JSON object matching this schema:

{
  "scope":         "self" | "division" | "pearl-wide",
  "division":      "BD" | "P2" | "CX/Core" | "Corporate" | "Product" | "Marketing" | null,
  "statusFilter":  string[] | null,    // monday status labels to include (e.g. ["Working on it","Stuck"])
  "searchTerm":    string | null,      // free-text to match against item names
  "limit":         number | null       // user-requested limit (default 10)
}

Examples:
"where's my request" → {"scope":"self","division":null,"statusFilter":null,"searchTerm":null,"limit":null}
"what's BD working on" → {"scope":"division","division":"BD","statusFilter":["Working on it"],"searchTerm":null,"limit":null}
"open Product requests" → {"scope":"division","division":"Product","statusFilter":["New","Working on it","Under Review","Stuck"],"searchTerm":null,"limit":null}
"show me everything" → {"scope":"pearl-wide","division":null,"statusFilter":null,"searchTerm":null,"limit":null}`;

const VALID_DIVISIONS: Division[] = [
  'BD',
  'P2',
  'CX/Core',
  'Corporate',
  'Product',
  'Marketing',
];

export interface QuerySpec {
  scope: 'self' | 'division' | 'pearl-wide';
  division: Division | null;
  statusFilter: string[] | null;
  searchTerm: string | null;
  limit: number;
}

const DEFAULT_LIMIT = 10;

export async function parseQuery(text: string): Promise<QuerySpec> {
  const cleaned = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  if (!cleaned) {
    return {
      scope: 'self',
      division: null,
      statusFilter: null,
      searchTerm: null,
      limit: DEFAULT_LIMIT,
    };
  }

  try {
    const response = await haiku().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: QUERY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cleaned }],
    });
    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(stripped);

    return {
      scope: ['self', 'division', 'pearl-wide'].includes(parsed.scope)
        ? parsed.scope
        : 'self',
      division: VALID_DIVISIONS.includes(parsed.division) ? parsed.division : null,
      statusFilter: Array.isArray(parsed.statusFilter) ? parsed.statusFilter : null,
      searchTerm: typeof parsed.searchTerm === 'string' ? parsed.searchTerm : null,
      limit:
        typeof parsed.limit === 'number' && parsed.limit > 0 && parsed.limit <= 20
          ? parsed.limit
          : DEFAULT_LIMIT,
    };
  } catch (err) {
    console.error('[visibility-query] parse failed, defaulting to self:', err);
    return {
      scope: 'self',
      division: null,
      statusFilter: null,
      searchTerm: null,
      limit: DEFAULT_LIMIT,
    };
  }
}

/**
 * Apply role-based defaults: intake channels default 'division' scope
 * to the channel's division; alerts channels default 'pearl-wide'.
 * Self queries are honored regardless of channel.
 */
export function applyChannelDefaults(
  spec: QuerySpec,
  channelId: string,
  role: ChannelRole,
): QuerySpec {
  if (spec.scope === 'self') return spec;

  if (role === 'alerts' && spec.scope === 'division' && !spec.division) {
    return { ...spec, scope: 'pearl-wide' };
  }

  if (role === 'intake' && !spec.division) {
    const channelDivision = divisionForChannel(channelId);
    if (channelDivision) {
      return { ...spec, division: channelDivision };
    }
  }

  return spec;
}

interface MondaySearchItem {
  id: string;
  name: string;
  url: string;
  requesterName: string | null;
  requestingForName: string | null;
  requestedDate: string | Date;
  status: string;
  division: string | null;
  owner: string | null;
}

/**
 * Format a query result list as a Slack mrkdwn message.
 * Per PRD US-008: short header line, up to ~10 items inline, footer
 * pointing to the Monday board view for full browsing.
 */
export function formatQueryResult(
  spec: QuerySpec,
  items: MondaySearchItem[],
  totalCount: number,
  asOf: Date = new Date(),
): string {
  const dateStr = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(asOf);

  const headerScope =
    spec.scope === 'self'
      ? 'Your open requests'
      : spec.scope === 'division'
      ? `Open ${spec.division ?? '?'} requests`
      : 'Open requests (Pearl-wide)';

  const lines: string[] = [`${headerScope} (as of ${dateStr}):`];
  const boardUrl = `https://pearlcertification-team.monday.com/boards/${config.mondayBoardId}`;

  if (items.length === 0) {
    lines.push('');
    lines.push('_No matching items._');
    lines.push('');
    lines.push(`See full board: <${boardUrl}|Open in Monday>`);
    return lines.join('\n');
  }

  const shown = items.slice(0, spec.limit);
  shown.forEach((item, i) => {
    lines.push(
      `${i + 1}. <${item.url}|${item.name}> · *${item.status}*${
        item.owner ? ` · ${item.owner} assigned` : ''
      }`,
    );
    lines.push(
      `   ${formatItemAttribution({
        requesterName: item.requesterName,
        requestedDate: item.requestedDate,
        requestingForName: item.requestingForName,
      })}`,
    );
  });

  lines.push('');
  lines.push(
    `${totalCount} open${shown.length < totalCount ? ` · showing ${shown.length}` : ''}`,
  );
  lines.push(`See full board: <${boardUrl}|Open in Monday>`);

  return lines.join('\n');
}

/**
 * Top-level handler — resolves an input @mention into a formatted
 * Slack reply. Real Monday query implementation in fetchItems is
 * deferred to runtime testing; for now we hit Monday's GraphQL API
 * via the existing helpers.
 */
export interface VisibilityQueryInput {
  text: string;
  channelId: string;
  threadTs: string;
  userSlackId: string;
  role: ChannelRole;
  say: (params: { text: string; thread_ts?: string }) => Promise<unknown>;
}

export async function handleVisibilityQuery(
  input: VisibilityQueryInput,
): Promise<void> {
  const { text, channelId, threadTs, userSlackId, role, say } = input;

  // Special-case: in an existing request thread, "where's my request"
  // means *this* request — return its current state.
  const ownThreadRequest = await getRequestByThread(channelId, threadTs);
  if (ownThreadRequest) {
    await say({
      text: formatSingleRequestStatus(ownThreadRequest),
      thread_ts: threadTs,
    });
    return;
  }

  let spec = await parseQuery(text);
  spec = applyChannelDefaults(spec, channelId, role);

  let records: RequestRecord[] = [];
  if (spec.scope === 'self') {
    records = await getRequestsByUser(userSlackId);
  } else if (spec.scope === 'division' && spec.division) {
    records = await getRequestsByDivision(spec.division);
  } else {
    records = await getAllOpenRequests();
  }

  // Apply status filter if specified.
  if (spec.statusFilter && spec.statusFilter.length > 0) {
    records = records.filter((r) => spec.statusFilter!.includes(r.status));
  }

  // Apply search term filter.
  if (spec.searchTerm) {
    const term = spec.searchTerm.toLowerCase();
    records = records.filter(
      (r) =>
        r.deliverable_summary?.toLowerCase().includes(term) ||
        r.request_type?.toLowerCase().includes(term),
    );
  }

  const items: MondaySearchItem[] = records.map((r) => ({
    id: r.monday_item_id,
    name: r.deliverable_summary?.slice(0, 60) ?? `Request #${r.id}`,
    url: buildMondayUrl(r.monday_item_id),
    requesterName: r.requester_user_id,
    requestingForName: r.requesting_for_user_id,
    requestedDate: r.submitted_at,
    status: r.status,
    division: r.division,
    owner: null,
  }));

  await say({
    text: formatQueryResult(spec, items, items.length),
    thread_ts: threadTs,
  });
}

export function describeSpec(spec: QuerySpec, userSlackId: string): string {
  const parts: string[] = [];
  if (spec.scope === 'self') parts.push(`Your requests`);
  else if (spec.scope === 'division') parts.push(`${spec.division} requests`);
  else parts.push('Pearl-wide requests');

  if (spec.statusFilter && spec.statusFilter.length > 0) {
    parts.push(`status in ${spec.statusFilter.join(' | ')}`);
  }
  if (spec.searchTerm) {
    parts.push(`matching "${spec.searchTerm}"`);
  }
  return `${parts.join(' · ')} for <@${userSlackId}>`;
}

function formatSingleRequestStatus(record: RequestRecord): string {
  const lines: string[] = [];
  lines.push(`Status: *${record.status}*`);
  if (record.deliverable_summary) {
    lines.push(`> ${record.deliverable_summary.slice(0, 150)}`);
  }
  lines.push(
    `Monday: <https://pearlcertification-team.monday.com/boards/${config.mondayBoardId}/pulses/${record.monday_item_id}|REQ-${record.monday_item_id}>`,
  );
  return lines.join('\n');
}
