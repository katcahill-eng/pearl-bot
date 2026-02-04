import { config } from './config';

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

// --- Group IDs (discovered from Monday.com API) ---

// Quick requests board ("Marketing Department Requests") → "Incoming Requests" group
const QUICK_BOARD_GROUP_ID = 'topics';
// Full projects board ("Active Marketing Projects WIP") → "Requested" group
const FULL_BOARD_GROUP_ID = 'group_mkw4sqp7';

// --- Public API ---

/**
 * Create a single item on the quick requests board in the "Incoming Requests" group.
 * Item is created with status "Under Review".
 */
export async function createQuickRequestItem(params: {
  name: string;
  dueDate?: string | null;
  requester: string;
  department?: string | null;
  target?: string | null;
  contextBackground?: string | null;
  desiredOutcomes?: string | null;
}): Promise<MondayResult> {
  try {
    const boardId = config.mondayQuickBoardId;

    const columnValues: Record<string, unknown> = {};

    // Column IDs from Monday.com API:
    // status → Status, short_textzhli70zj → Requesting Person and Department,
    // short_text850qt5t1 → Target, long_textcrvijt4x → Context & Background,
    // long_textrywmn305 → Desired Outcomes, long_textljfnnagq → Deliverable(s),
    // date → Due Date, long_text8tv0hcfw → Approvals and Constraints,
    // long_textfktkwj3y → Supporting Links

    columnValues['status'] = { label: 'Under Review' };

    if (params.dueDate) {
      columnValues['date'] = { date: params.dueDate };
    }
    if (params.requester || params.department) {
      const parts = [params.requester, params.department].filter(Boolean);
      columnValues['short_textzhli70zj'] = parts.join(' — ');
    }
    if (params.target) {
      columnValues['short_text850qt5t1'] = params.target;
    }
    if (params.contextBackground) {
      columnValues['long_textcrvijt4x'] = { text: params.contextBackground };
    }
    if (params.desiredOutcomes) {
      columnValues['long_textrywmn305'] = { text: params.desiredOutcomes };
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
      groupId: QUICK_BOARD_GROUP_ID,
      itemName: params.name,
      columnValues: JSON.stringify(columnValues),
    });

    const itemId = data.create_item.id;
    const mondayBoardId = data.create_item.board.id;

    return {
      success: true,
      itemId,
      boardUrl: `https://pearl-certification.monday.com/boards/${mondayBoardId}/pulses/${itemId}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Monday.com error';
    console.error('[monday] createQuickRequestItem failed:', message);
    return { success: false, error: `Monday.com error: ${message}` };
  }
}

/**
 * Create an item on the full projects board in the "Requested" group.
 * Item is created with status "Under Review".
 */
export async function createFullProjectItem(params: {
  name: string;
  deliverables: string[];
  dueDate?: string | null;
  requester: string;
  department?: string | null;
  target?: string | null;
  contextBackground?: string | null;
  desiredOutcomes?: string | null;
}): Promise<MondayResult> {
  try {
    const boardId = config.mondayFullBoardId;

    const columnValues: Record<string, unknown> = {};

    // Column IDs from Monday.com API:
    // color_mkwrswkb → Status, link_mkx795n7 → Project Folder

    columnValues['color_mkwrswkb'] = { label: 'Under Review' };

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
      groupId: FULL_BOARD_GROUP_ID,
      itemName: params.name,
      columnValues: JSON.stringify(columnValues),
    });

    const itemId = data.create_item.id;
    const mondayBoardId = data.create_item.board.id;

    return {
      success: true,
      itemId,
      boardUrl: `https://pearl-certification.monday.com/boards/${mondayBoardId}/pulses/${itemId}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Monday.com error';
    console.error('[monday] createFullProjectItem failed:', message);
    return { success: false, error: `Monday.com error: ${message}` };
  }
}

// Status column IDs per board (discovered from Monday.com API)
// Quick board: "status", Full board: "color_mkwrswkb"
export const QUICK_BOARD_STATUS_COLUMN = 'status';
export const FULL_BOARD_STATUS_COLUMN = 'color_mkwrswkb';
// Full board: link column for Project Folder
export const FULL_BOARD_FOLDER_LINK_COLUMN = 'link_mkx795n7';

/**
 * Update the status column of a Monday.com item.
 * Used by the approval handler to move items from "Under Review" to active.
 */
export async function updateMondayItemStatus(
  itemId: string,
  boardId: string,
  newStatusLabel: string,
): Promise<void> {
  // Pick the correct status column ID based on which board
  const statusColumnId = boardId === config.mondayFullBoardId
    ? FULL_BOARD_STATUS_COLUMN
    : QUICK_BOARD_STATUS_COLUMN;

  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }
  `;

  await mondayApi(query, {
    boardId,
    itemId,
    columnValues: JSON.stringify({
      [statusColumnId]: { label: newStatusLabel },
    }),
  });
}

/**
 * Update column values on an existing Monday.com item.
 * Used after approval to add Drive/brief links.
 */
export async function updateMondayItemColumns(
  itemId: string,
  boardId: string,
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
    boardId,
    itemId,
    columnValues: JSON.stringify(columnValues),
  });
}

/**
 * Add an update (comment) to a Monday.com item.
 * Uses the create_update mutation to post a comment on the item's activity log.
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
 * Search Monday.com boards for items matching a query string.
 */
export async function searchItems(query: string): Promise<MondaySearchResult[]> {
  try {
    const boardIds = [
      config.mondayQuickBoardId,
      config.mondayFullBoardId,
    ];

    const results: MondaySearchResult[] = [];

    for (const boardId of boardIds) {
      try {
        const boardQuery = `
          query ($boardId: [ID!]!, $query: String!) {
            boards (ids: $boardId) {
              items_page (limit: 10, query_params: { rules: [{ column_id: "name", compare_value: [$query] }] }) {
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
          query: query,
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
              boardUrl: `https://pearl-certification.monday.com/boards/${item.board.id}/pulses/${item.id}`,
              updatedAt: item.updated_at,
            });
          }
        }
      } catch {
        // Skip boards that fail — partial search is better than no search
        continue;
      }
    }

    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Monday.com error';
    console.error('[monday] searchItems failed:', message);
    return [];
  }
}
