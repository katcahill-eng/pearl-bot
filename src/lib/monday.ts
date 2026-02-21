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

async function mondayApi<T = unknown>(
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
