import { config } from './config';

// --- Constants ---

const MONDAY_DOMAIN = 'pearlcertification-team.monday.com';
const BOARD_GROUP_ID = 'topics'; // "Incoming Requests" group
const STATUS_COLUMN_ID = 'status';

// Column IDs on the "Marketing Department Requests" board
const COL = {
  status: 'status',
  dueDate: 'date',
  requester: 'short_textzhli70zj',       // "Requesting Person and Department"
  target: 'short_text850qt5t1',           // "Target"
  context: 'long_textcrvijt4x',          // "Context & Background"
  desiredOutcomes: 'long_textrywmn305',   // "Desired Outcomes"
  deliverables: 'long_textljfnnagq',      // "Deliverable(s)"
  supportingLinks: 'long_textfktkwj3y',   // "Supporting Links"
  supportingDocuments: 'files',            // "Supporting Documents" — file column
  approvals: 'long_text',                 // "Approvals"
  constraints: 'long_text39r056im',       // "Constraints"
  approvalsConstraints: 'long_text8tv0hcfw', // "Approvals and Constraints" (legacy combined)
  deliverableType: 'status_16',           // "Type of Deliverable"
  priority: 'status_1',                   // "Priority"
  owner: 'person',                        // "Owner" — people column
  submissionLink: 'wf_edit_link_seldq',   // "Submission link" — link to originating Slack thread
} as const;

// --- Types ---

export interface MondayResult {
  success: boolean;
  itemId?: string;
  boardUrl?: string;
  error?: string;
}

export interface MondaySearchResult {
  id: string;
  name: string;
  status?: string;
  dueDate?: string;
  assignee?: string;
  boardUrl: string;
  updatedAt?: string;
}

interface MondayApiResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string }>;
}

// --- GraphQL Client ---

export async function mondayApi<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: config.mondayApiToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Monday.com API returned ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as MondayApiResponse<T>;

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Monday.com API error: ${json.errors[0].message}`);
  }

  if (!json.data) {
    throw new Error('Monday.com API returned no data');
  }

  return json.data;
}

// --- Column Discovery (one-time, for mapping new columns) ---

export async function discoverBoardColumns(): Promise<void> {
  try {
    const data = await mondayApi<{
      boards: Array<{ columns: Array<{ id: string; title: string; type: string; settings_str: string }> }>;
    }>(`query ($boardId: [ID!]!) { boards(ids: $boardId) { columns { id title type settings_str } } }`, {
      boardId: [config.mondayBoardId],
    });
    console.log('[monday] Board columns:');
    for (const col of data.boards[0].columns) {
      let extra = '';
      if (col.type === 'status') {
        try {
          const settings = JSON.parse(col.settings_str);
          const labels = settings.labels ? Object.values(settings.labels) : [];
          if (labels.length > 0) extra = ` → labels: ${(labels as string[]).join(', ')}`;
        } catch { /* ignore */ }
      }
      console.log(`  ${col.id.padEnd(30)} ${col.type.padEnd(15)} ${col.title}${extra}`);
    }
  } catch (err) {
    console.error('[monday] Column discovery failed:', err);
  }
}

// --- Deliverable Type Mapping ---
// Maps keywords from deliverables[] and request context to Monday's "Type of Deliverable" status labels.
// When the user updates Monday labels, update this map to match.

const DELIVERABLE_TYPE_KEYWORDS: { label: string; patterns: RegExp[] }[] = [
  { label: 'Email', patterns: [/\bemail/i, /\bnewsletter/i, /\bemail\s*campaign/i, /\bemail\s*sequence/i, /\bemail\s*template/i] },
  { label: 'Presentation', patterns: [/\bpresentation/i, /\bslide\s*deck/i, /\bslides?\b/i, /\bkeynote/i, /\bpowerpoint/i, /\bgoogle\s*slides/i] },
  { label: 'Social Media', patterns: [/\bsocial\s*media/i, /\bsocial\s*post/i, /\bsocial\s*graphic/i, /\blinkedin\s*post/i, /\binstagram/i, /\btwitter/i, /\bfacebook\s*post/i] },
  { label: 'New Webpage', patterns: [/\blanding\s*page/i, /\bnew\s*(web)?page/i, /\bcampaign\s*page/i] },
  { label: 'Website Update', patterns: [/\bwebsite\s*update/i, /\bupdate\s+(the\s+)?(website|webpage|site|page)/i, /\bweb\s*(page\s*)?edit/i, /\bedit\s+(the\s+)?(website|webpage|page)/i] },
  { label: 'Graphic Design Support', patterns: [/\bgraphic/i, /\blogo\b/i, /\bvisual\s*asset/i, /\bdesign\s*support/i, /\binfographic/i] },
  { label: 'Advertising', patterns: [/\b(digital\s*)?ads?\b/i, /\badvertis/i, /\bad\s*creative/i, /\bad\s*campaign/i, /\bgoogle\s*ads?/i, /\blinkedin\s*ads?/i, /\bmeta\s*ads?/i, /\bfacebook\s*ads?/i] },
  { label: 'Ebook/White Paper', patterns: [/\bebook/i, /\be-book/i, /\bwhite\s*paper/i, /\bwhitepaper/i, /\bguide\b/i] },
  { label: 'Press Release', patterns: [/\bpress\s*release/i, /\bpr\s*release/i, /\bmedia\s*release/i] },
  { label: 'B2B Blog Post', patterns: [/\bb2b\s*blog/i, /\bblog\s*post.*\b(agent|broker|partner|b2b)/i] },
  { label: 'B2C Blog Post', patterns: [/\bb2c\s*blog/i, /\bblog\s*post.*\b(homeowner|consumer|b2c)/i] },
  { label: 'Document', patterns: [/\bone[- ]?pager/i, /\bflyer/i, /\bbrochure/i, /\bhandout/i, /\bcollateral/i, /\bsignage/i, /\bbanner/i, /\bprint/i] },
  { label: 'Research', patterns: [/\bresearch/i, /\breport\b/i, /\banalysis\b/i, /\bsurvey\b/i, /\bmarket\s*research/i] },
  { label: 'Trade show Support', patterns: [/\btrade\s*show/i, /\bexpo\b/i, /\bexhibit/i, /\bbooth\b/i, /\bconference/i, /\bdigital\s*booth/i] },
  { label: 'Webinar', patterns: [/\bwebinar/i, /\bweb\s*session/i, /\bonline\s*presentation/i] },
  { label: 'Event', patterns: [/\bdinner/i, /\breception/i, /\bevent\s*brand/i, /\binvitation/i, /\binsider/i] },
];

/**
 * Determine the best "Type of Deliverable" Monday status label from deliverables and context.
 * Returns { label, unmatched } — unmatched contains deliverables that didn't map to any type.
 */
export function classifyDeliverableType(
  deliverables: string[],
  contextBackground: string | null,
  requestTypes: string[] | null,
): { label: string | null; unmatched: string[] } {
  const allText = [...deliverables, contextBackground ?? ''].join(' ');
  const matchedLabels = new Map<string, number>(); // label → match count
  const matchedDeliverables = new Set<number>(); // indices of matched deliverables

  // Score each label by how many pattern matches it gets
  for (const { label, patterns } of DELIVERABLE_TYPE_KEYWORDS) {
    for (const pattern of patterns) {
      // Check against each deliverable
      for (let i = 0; i < deliverables.length; i++) {
        if (pattern.test(deliverables[i])) {
          matchedLabels.set(label, (matchedLabels.get(label) ?? 0) + 2); // deliverable match weighs more
          matchedDeliverables.add(i);
        }
      }
      // Check against context
      if (contextBackground && pattern.test(contextBackground)) {
        matchedLabels.set(label, (matchedLabels.get(label) ?? 0) + 1);
      }
    }
  }

  // Also check request types from Claude classification
  if (requestTypes) {
    const typeToLabel: Record<string, string> = {
      conference: 'Trade show Support',
      webinar: 'Webinar',
      insider_dinner: 'Event',
      email: 'Email',
      graphic_design: 'Graphic Design Support',
      blog_post: 'B2B Blog Post',  // default to B2B; keyword matching can override to B2C
      ebook: 'Ebook/White Paper',
      press_release: 'Press Release',
      research: 'Research',
      advertising: 'Advertising',
      landing_page: 'New Webpage',
      website_update: 'Website Update',
      presentation: 'Presentation',
      social_media: 'Social Media',
    };
    for (const rt of requestTypes) {
      const mapped = typeToLabel[rt];
      if (mapped && !matchedLabels.has(mapped)) {
        matchedLabels.set(mapped, 1);
      }
    }
  }

  // Pick the label with the highest score
  let bestLabel: string | null = null;
  let bestScore = 0;
  for (const [label, score] of matchedLabels) {
    if (score > bestScore) {
      bestLabel = label;
      bestScore = score;
    }
  }

  // Identify unmatched deliverables
  const unmatched = deliverables.filter((_, i) => !matchedDeliverables.has(i));

  return { label: bestLabel, unmatched };
}

// --- Monday User Lookup ---

let mondayUsersCache: { id: number; email: string; name: string }[] | null = null;
let mondayUsersCacheTime = 0;
const MONDAY_USERS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Find a Monday.com user ID by email address.
 * Caches the full user list (1-hour TTL) since the list is small.
 */
export async function findMondayUserByEmail(email: string): Promise<number | null> {
  const now = Date.now();
  if (!mondayUsersCache || now - mondayUsersCacheTime > MONDAY_USERS_CACHE_TTL) {
    try {
      const data = await mondayApi<{
        users: Array<{ id: number; email: string; name: string }>;
      }>('query { users { id email name } }');
      mondayUsersCache = data.users;
      mondayUsersCacheTime = now;
    } catch (err) {
      console.error('[monday] Failed to fetch Monday users:', err);
      return null;
    }
  }

  const normalizedEmail = email.toLowerCase();
  const match = mondayUsersCache.find((u) => u.email.toLowerCase() === normalizedEmail);
  return match ? match.id : null;
}

// --- Public API ---

/**
 * Build a Monday.com URL for a board item.
 */
export function buildMondayUrl(itemId: string): string {
  return `https://${MONDAY_DOMAIN}/boards/${config.mondayBoardId}/pulses/${itemId}`;
}

/**
 * Create an item on the Marketing Department Requests board.
 * All requests (quick and full) go to the same board.
 */
export async function createRequestItem(params: {
  name: string;
  dueDate?: string | null;
  requester: string;
  department?: string | null;
  target?: string | null;
  contextBackground?: string | null;
  desiredOutcomes?: string | null;
  deliverables?: string[] | null;
  supportingLinks?: string | null;
  approvals?: string | null;
  constraints?: string | null;
  deliverableType?: string | null;
  ownerUserId?: number | null;
  submissionLink?: string | null;
}): Promise<MondayResult> {
  try {
    const boardId = config.mondayBoardId;
    const columnValues: Record<string, unknown> = {};

    columnValues[COL.status] = { label: 'Under Review' };

    if (params.dueDate) {
      columnValues[COL.dueDate] = { date: params.dueDate };
    }
    if (params.requester || params.department) {
      const parts = [params.requester, params.department].filter(Boolean);
      columnValues[COL.requester] = parts.join(' — ');
    }
    if (params.target) {
      columnValues[COL.target] = params.target;
    }
    if (params.contextBackground) {
      columnValues[COL.context] = { text: params.contextBackground };
    }
    if (params.desiredOutcomes) {
      columnValues[COL.desiredOutcomes] = { text: params.desiredOutcomes };
    }
    if (params.deliverables && params.deliverables.length > 0) {
      columnValues[COL.deliverables] = { text: params.deliverables.join(', ') };
    }
    if (params.supportingLinks) {
      columnValues[COL.supportingLinks] = { text: params.supportingLinks };
    }
    if (params.approvals) {
      columnValues[COL.approvals] = { text: params.approvals };
    }
    if (params.constraints) {
      columnValues[COL.constraints] = { text: params.constraints };
    }
    if (params.deliverableType) {
      columnValues[COL.deliverableType] = { label: params.deliverableType };
    }
    if (params.ownerUserId) {
      columnValues[COL.owner] = { personsAndTeams: [{ id: params.ownerUserId, kind: 'person' }] };
    }
    if (params.submissionLink) {
      columnValues[COL.submissionLink] = { url: params.submissionLink, text: 'Slack thread' };
    }

    const query = `
      mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
        create_item (board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
          id
          board {
            id
          }
        }
      }
    `;

    const data = await mondayApi<{
      create_item: { id: string; board: { id: string } };
    }>(query, {
      boardId,
      groupId: BOARD_GROUP_ID,
      itemName: params.name,
      columnValues: JSON.stringify(columnValues),
    });

    const itemId = data.create_item.id;

    return {
      success: true,
      itemId,
      boardUrl: buildMondayUrl(itemId),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Monday.com error';
    console.error('[monday] createRequestItem failed:', message);
    return { success: false, error: `Monday.com error: ${message}` };
  }
}

/**
 * Update the status column of a Monday.com item.
 */
export async function updateMondayItemStatus(
  itemId: string,
  newStatusLabel: string,
): Promise<void> {
  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }
  `;

  await mondayApi(query, {
    boardId: config.mondayBoardId,
    itemId,
    columnValues: JSON.stringify({
      [STATUS_COLUMN_ID]: { label: newStatusLabel },
    }),
  });
}

/**
 * Update column values on an existing Monday.com item.
 * Used after approval to add Drive/brief links.
 */
export async function updateMondayItemColumns(
  itemId: string,
  columnValues: Record<string, unknown>,
): Promise<void> {
  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }
  `;

  await mondayApi(query, {
    boardId: config.mondayBoardId,
    itemId,
    columnValues: JSON.stringify(columnValues),
  });
}

/**
 * Add an update (comment) to a Monday.com item.
 */
export async function addMondayItemUpdate(
  itemId: string,
  body: string,
): Promise<void> {
  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update (item_id: $itemId, body: $body) {
        id
      }
    }
  `;

  await mondayApi(query, { itemId, body });
}

/**
 * Search Monday.com board for items matching a query string.
 */
export async function searchItems(query: string): Promise<MondaySearchResult[]> {
  try {
    const boardId = config.mondayBoardId;
    const results: MondaySearchResult[] = [];

    // compare_value requires inline values (not GraphQL variables) in Monday.com's API
    const escapedQuery = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const boardQuery = `
      query ($boardId: [ID!]!) {
        boards (ids: $boardId) {
          items_page (limit: 10, query_params: { rules: [{ column_id: "name", compare_value: ["${escapedQuery}"], operator: contains_text }] }) {
            items {
              id
              name
              board {
                id
              }
              column_values {
                id
                text
              }
              updated_at
            }
          }
        }
      }
    `;

    const data = await mondayApi<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string;
            name: string;
            board: { id: string };
            column_values: Array<{ id: string; text: string }>;
            updated_at: string;
          }>;
        };
      }>;
    }>(boardQuery, {
      boardId: [boardId],
    });

    for (const board of data.boards) {
      for (const item of board.items_page.items) {
        const statusCol = item.column_values.find(
          (c) => c.id === 'status' || c.id === 'status4',
        );
        const dateCol = item.column_values.find(
          (c) => c.id === 'date' || c.id === 'date4',
        );
        const personCol = item.column_values.find(
          (c) => c.id === 'person' || c.id === 'people',
        );

        results.push({
          id: item.id,
          name: item.name,
          status: statusCol?.text ?? undefined,
          dueDate: dateCol?.text ?? undefined,
          assignee: personCol?.text ?? undefined,
          boardUrl: buildMondayUrl(item.id),
          updatedAt: item.updated_at,
        });
      }
    }

    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Monday.com error';
    console.error('[monday] searchItems failed:', message);
    return [];
  }
}

/**
 * Upload a file to the "Supporting Documents" file column on a Monday.com item.
 * Downloads the file from Slack (using bot token), then re-uploads to Monday.
 */
export async function uploadFileToItem(
  itemId: string,
  slackFileUrl: string,
  fileName: string,
  slackBotToken: string,
): Promise<void> {
  // Step 1: Download file from Slack (requires bot token auth)
  const slackRes = await fetch(slackFileUrl, {
    headers: { Authorization: `Bearer ${slackBotToken}` },
  });

  if (!slackRes.ok) {
    throw new Error(`Failed to download file from Slack: ${slackRes.status} ${slackRes.statusText}`);
  }

  const fileBuffer = Buffer.from(await slackRes.arrayBuffer());

  // Step 2: Upload to Monday.com via multipart form (add_file_to_column)
  const query = `mutation ($itemId: ID!, $columnId: String!, $file: File!) {
    add_file_to_column (item_id: $itemId, column_id: $columnId, file: $file) {
      id
    }
  }`;

  const boundary = `----MondayUpload${Date.now()}`;
  const parts: Buffer[] = [];

  // "query" part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="query"\r\n\r\n${query}\r\n`
  ));

  // "variables" part — must include map for file variable
  const variables = JSON.stringify({ itemId, columnId: COL.supportingDocuments });
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="variables"\r\n\r\n${variables}\r\n`
  ));

  // "map" part — tells Monday which variable is the file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="map"\r\n\r\n{"image":"variables.file"}\r\n`
  ));

  // The actual file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const mondayRes = await fetch('https://api.monday.com/v2/file', {
    method: 'POST',
    headers: {
      Authorization: config.mondayApiToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!mondayRes.ok) {
    const errText = await mondayRes.text();
    throw new Error(`Monday.com file upload failed: ${mondayRes.status} ${errText}`);
  }

  const json = (await mondayRes.json()) as MondayApiResponse;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Monday.com file upload error: ${json.errors[0].message}`);
  }
}

// Re-export column IDs for use by workflow.ts
export { COL as MONDAY_COLUMNS };

// --- Sage v2 column IDs ---
// Structured columns added for the channel-native intake. These coexist
// with the v3 COL constants above; v2 writes to BOTH the new structured
// columns AND the legacy text columns so the form-based intake keeps
// working until form retirement.

const COL_V2 = {
  requesterPeople: 'multiple_person_mm2qqzxk', // "Requester" (People)
  approvalsPeople: 'multiple_person_mm2qzpq',  // "Approvals (People)"
  requestingFor: 'multiple_person_mm2qt1nx',   // "Requesting For" (People)
  requestingDivision: 'color_mm2q52zc',        // "Requesting Division" (status)
  additionalDivisions: 'dropdown_mm32cr4w',    // "Additional Divisions Impacted" (dropdown)
  rush: 'color_mm33neda',                       // "Rush" (status: Standard / Rush)
} as const;

export interface CreateV2RequestParams {
  /** Project Title — short summary that appears as the item name. */
  name: string;
  division: string; // 'BD' | 'P2' | 'CX/Core' | 'Corporate' | 'Product' | 'Marketing'
  /** Pearl Slack user ID of the person who SUBMITTED the modal. */
  submitterSlackUserId: string;
  /** Resolved Monday user ID for the requester (NOT the Slack ID). */
  requesterMondayUserId: number;
  /** Resolved Monday user IDs for approvers (may be empty). */
  approverMondayUserIds: number[];
  /** Resolved Monday user ID for proxy submission target, if any. */
  requestingForMondayUserId?: number | null;
  /** Multi-select of additional divisions impacted (may be empty). */
  additionalDivisions?: string[];
  /** Type of Deliverable — must match a label in the status_16 column. */
  deliverableType?: string | null;
  /** Long-form deliverable description. */
  deliverable: string;
  audience?: string | null;
  contextBackground?: string | null;
  desiredOutcomes?: string | null;
  dueDate?: string | null; // ISO YYYY-MM-DD
  /** Free-form approver names (legacy long_text — written for form compatibility). */
  legacyApproversText?: string | null;
  /** Free-form requester+department string (legacy short_text — written for form compatibility). */
  legacyRequesterText?: string | null;
  /** Slack thread permalink to the originating mention. */
  submissionLink?: string | null;
  /** Supporting links / draft source material — populated from the
   *  form's "Draft or source material" field. */
  supportingLinks?: string | null;
  /** Rush flag — true when deadline is less than Pearl's 2-week minimum. */
  rush?: boolean;
}

/**
 * Create a Sage v2 marketing request item on the 00. board with all
 * structured v2 columns populated. Returns { id, url } for the new item.
 */
export async function createV2RequestItem(
  params: CreateV2RequestParams,
): Promise<{ id: string; url: string }> {
  const boardId = config.mondayBoardId;
  const columnValues: Record<string, unknown> = {};

  // Status starts at "New" — marketing triages from there.
  columnValues[COL.status] = { label: 'New' };

  // Division (status enum)
  columnValues[COL_V2.requestingDivision] = { label: params.division };

  // Requester (People) — required per FR-6
  columnValues[COL_V2.requesterPeople] = {
    personsAndTeams: [{ id: params.requesterMondayUserId, kind: 'person' }],
  };

  // Approvals (People)
  if (params.approverMondayUserIds.length > 0) {
    columnValues[COL_V2.approvalsPeople] = {
      personsAndTeams: params.approverMondayUserIds.map((id) => ({
        id,
        kind: 'person',
      })),
    };
  }

  // Requesting For (People)
  if (params.requestingForMondayUserId) {
    columnValues[COL_V2.requestingFor] = {
      personsAndTeams: [{ id: params.requestingForMondayUserId, kind: 'person' }],
    };
  }

  // Additional Divisions Impacted (dropdown)
  if (params.additionalDivisions && params.additionalDivisions.length > 0) {
    columnValues[COL_V2.additionalDivisions] = {
      labels: params.additionalDivisions,
    };
  }

  // Rush flag — Standard by default, Rush if assessRush flagged it.
  columnValues[COL_V2.rush] = { label: params.rush ? 'Rush' : 'Standard' };

  // Type of Deliverable (status enum)
  if (params.deliverableType) {
    columnValues[COL.deliverableType] = { label: params.deliverableType };
  }

  // Deliverable(s) long_text — only written if explicitly provided.
  // v2 leaves this empty: the Type of Deliverable status column
  // captures the format, and the long-form description lives in
  // Context & Background.
  if (params.deliverable) {
    columnValues[COL.deliverables] = { text: params.deliverable };
  }

  // Audience (Target column)
  if (params.audience) {
    columnValues[COL.target] = params.audience;
  }

  // Context & Background
  if (params.contextBackground) {
    columnValues[COL.context] = { text: params.contextBackground };
  }

  // Desired Outcomes
  if (params.desiredOutcomes) {
    columnValues[COL.desiredOutcomes] = { text: params.desiredOutcomes };
  }

  // Due Date
  if (params.dueDate) {
    columnValues[COL.dueDate] = { date: params.dueDate };
  }

  // Legacy text fields (written so the existing form view still
  // renders meaningful values until the form is retired).
  if (params.legacyApproversText) {
    columnValues[COL.approvals] = { text: params.legacyApproversText };
  }
  if (params.legacyRequesterText) {
    columnValues[COL.requester] = params.legacyRequesterText;
  }
  if (params.submissionLink) {
    columnValues[COL.submissionLink] = {
      url: params.submissionLink,
      text: 'Slack thread',
    };
  }
  if (params.supportingLinks) {
    columnValues[COL.supportingLinks] = { text: params.supportingLinks };
  }

  const query = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item (board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const variables = {
    boardId,
    groupId: BOARD_GROUP_ID,
    itemName: params.name,
    columnValues: JSON.stringify(columnValues),
  };

  const result = await mondayApi<{ create_item: { id: string } | null }>(
    query,
    variables,
  );

  const itemId = result.create_item?.id;
  if (!itemId) {
    throw new Error('[monday-v2] create_item returned no id');
  }

  return { id: itemId, url: buildMondayUrl(itemId) };
}

export interface CreateV2SubItemParams {
  parentItemId: string;
  /** Sub-item name — typically the recommendation deliverable text. */
  name: string;
  recommendation: { name: string; deliverable: string };
}

/**
 * Create a sub-item of a v2 request for a checked director-brain
 * recommendation. Sub-items inherit their parent's metadata via
 * Monday's subitem mechanism — no need to duplicate columns here.
 */
export async function createV2SubItem(
  params: CreateV2SubItemParams,
): Promise<{ id: string }> {
  const query = `
    mutation ($parentId: ID!, $itemName: String!) {
      create_subitem (parent_item_id: $parentId, item_name: $itemName) {
        id
      }
    }
  `;
  const variables = {
    parentId: params.parentItemId,
    // Use the human-readable deliverable text as the sub-item name —
    // the slug (recommendation.name) is internal tracking only and was
    // showing as awkward prefix like "webinar-platform: ..." in Monday.
    itemName: params.recommendation.deliverable.slice(0, 255),
  };
  const result = await mondayApi<{ create_subitem: { id: string } | null }>(
    query,
    variables,
  );
  const id = result.create_subitem?.id;
  if (!id) throw new Error('[monday-v2] create_subitem returned no id');
  return { id };
}

/**
 * Create a minimal Monday item for a bug report or feature suggestion.
 * Lands in the same "Incoming Requests" group so marketing sees it in triage.
 */
export async function createFeedbackItem(params: {
  kind: 'bug' | 'feature';
  description: string;
  submitterSlackUserId: string;
  mondayUserId?: number | null;
  submissionLink?: string | null;
  requesterLabel?: string | null;
}): Promise<{ id: string; url: string }> {
  const prefix = params.kind === 'bug' ? '🐛 Bug:' : '💡 Feature:';
  const itemName = `${prefix} ${params.description.slice(0, 120)}`;

  const columnValues: Record<string, unknown> = {
    [COL.status]: { label: 'New' },
    [COL.context]: { text: params.description },
    [COL.requester]: params.requesterLabel ?? params.submitterSlackUserId,
  };

  if (params.mondayUserId) {
    columnValues[COL_V2.requesterPeople] = {
      personsAndTeams: [{ id: params.mondayUserId, kind: 'person' }],
    };
  }

  if (params.submissionLink) {
    columnValues[COL.submissionLink] = { url: params.submissionLink, text: 'Slack thread' };
  }

  const query = `
    mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item (board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const result = await mondayApi<{ create_item: { id: string } | null }>(query, {
    boardId: config.mondayBoardId,
    groupId: BOARD_GROUP_ID,
    itemName,
    columnValues: JSON.stringify(columnValues),
  });

  const id = result.create_item?.id;
  if (!id) throw new Error('[monday] createFeedbackItem returned no id');
  return { id, url: buildMondayUrl(id) };
}
