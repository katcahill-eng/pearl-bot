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

// --- Group IDs ---

// Quick requests board → "Incoming Requests" group
const QUICK_BOARD_GROUP_ID = 'incoming_requests';
// Full projects board → "Requested" group
const FULL_BOARD_GROUP_ID = 'requested';

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

    // Status: "Under Review"
    columnValues['status'] = { label: 'Under Review' };

    if (params.dueDate) {
      columnValues['date'] = { date: params.dueDate };
    }
    if (params.requester) {
      columnValues['text'] = params.requester;
    }
    if (params.department) {
      columnValues['text6'] = params.department;
    }
    if (params.target) {
      columnValues['text9'] = params.target;
    }
    if (params.contextBackground) {
      columnValues['long_text'] = { text: params.contextBackground };
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

    // Status: "Under Review"
    columnValues['status'] = { label: 'Under Review' };

    if (params.dueDate) {
      columnValues['date'] = { date: params.dueDate };
    }
    if (params.requester) {
      columnValues['text'] = params.requester;
    }
    if (params.department) {
      columnValues['text6'] = params.department;
    }
    if (params.target) {
      columnValues['text9'] = params.target;
    }
    if (params.contextBackground) {
      columnValues['long_text'] = { text: params.contextBackground };
    }
    if (params.deliverables.length > 0) {
      columnValues['text0'] = params.deliverables.join(', ');
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

/**
 * Update the status column of a Monday.com item.
 * Used by the approval handler to move items from "Under Review" to active.
 */
export async function updateMondayItemStatus(
  itemId: string,
  boardId: string,
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
    boardId,
    itemId,
    columnValues: JSON.stringify({
      status: { label: newStatusLabel },
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
