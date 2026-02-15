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
  approvalsConstraints: 'long_text8tv0hcfw', // "Approvals and Constraints"
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

// Re-export column IDs for use by workflow.ts
export { COL as MONDAY_COLUMNS };
