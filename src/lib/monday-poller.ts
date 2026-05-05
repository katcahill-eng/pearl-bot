/**
 * Sage v2 Monday polling fallback.
 *
 * When Monday webhooks aren't available (plan limitation, network
 * restrictions), this poller queries the 00. board on an interval and
 * emits synthetic LifecycleEvents for any column changes since the last
 * tick. Same downstream handler as the webhook receiver
 * (composeAndPostLifecycleReply) so the user-visible behavior is
 * identical at a 5-minute lag.
 *
 * Enabled by setting MONDAY_USE_POLLING=true in env. The webhook path
 * is otherwise the default; both can run simultaneously without harm
 * (composeAndPostLifecycleReply de-dups identical events within 30s).
 */

import type { WebClient } from '@slack/web-api';
import { config } from './config';
import {
  composeAndPostLifecycleReply,
  type LifecycleEvent,
} from './lifecycle-composer';
import { logRequestEvent } from './event-log';
import { trackError } from './error-tracker';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const LOOKBACK_MS = 6 * 60 * 1000; // generous buffer past poll interval

interface ItemSnapshot {
  status?: string;
  due_date?: string;
  owner?: string;
  additional_divisions?: string[];
}

/** In-memory cache of last-seen state per Monday item id. */
const lastSeen = new Map<string, ItemSnapshot>();

interface MondayBoardItem {
  id: string;
  name: string;
  updated_at: string;
  column_values: { id: string; text: string; value: string | null }[];
}

async function fetchChangedItems(): Promise<MondayBoardItem[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const query = `
    query ($boardId: ID!, $cutoff: ISO8601DateTime!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100, query_params: { rules: [{ column_id: "__updated_at__", compare_value: [$cutoff], operator: greater_than }] }) {
          items {
            id
            name
            updated_at
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;
  // The above filter syntax may not be supported on every Monday plan;
  // when it isn't, we fall through to a simpler query and filter in memory.
  try {
    const { mondayApi } = await import('./monday');
    const data = await mondayApi<{
      boards: { items_page: { items: MondayBoardItem[] } }[];
    }>(query, { boardId: config.mondayBoardId, cutoff });
    return data.boards?.[0]?.items_page?.items ?? [];
  } catch {
    // Fallback: pull a recent page and filter client-side.
    const fallback = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(limit: 100) {
            items { id name updated_at column_values { id text value } }
          }
        }
      }
    `;
    const { mondayApi } = await import('./monday');
    const data = await mondayApi<{
      boards: { items_page: { items: MondayBoardItem[] } }[];
    }>(fallback, { boardId: config.mondayBoardId });
    const items = data.boards?.[0]?.items_page?.items ?? [];
    const cutoffMs = Date.now() - LOOKBACK_MS;
    return items.filter((it: MondayBoardItem) => Date.parse(it.updated_at) >= cutoffMs);
  }
}

/**
 * Compare a fresh snapshot against the cached one and emit one
 * LifecycleEvent per changed dimension.
 */
export function diffSnapshots(
  prev: ItemSnapshot | undefined,
  next: ItemSnapshot,
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];

  if (next.status && prev?.status !== next.status) {
    events.push({
      kind: 'status_change',
      oldStatus: prev?.status ?? null,
      newStatus: next.status,
    });
  }
  if (next.due_date && prev?.due_date !== next.due_date) {
    events.push({ kind: 'due_date_changed', newDate: next.due_date });
  }
  if (next.owner && prev?.owner !== next.owner) {
    events.push({ kind: 'owner_changed', ownerName: next.owner });
  }
  if (
    next.additional_divisions &&
    JSON.stringify(prev?.additional_divisions ?? []) !==
      JSON.stringify(next.additional_divisions)
  ) {
    events.push({
      kind: 'additional_divisions_changed',
      divisions: next.additional_divisions,
    });
  }

  return events;
}

function snapshotFromItem(item: MondayBoardItem): ItemSnapshot {
  const cv = (id: string, title?: string) =>
    item.column_values.find(
      (c) => c.id === id || (title && c.id.toLowerCase().includes(title.toLowerCase())),
    );
  const status = cv('status')?.text || undefined;
  const dueDate = cv('date')?.text || undefined;
  const owner = cv('person')?.text || undefined;
  const additional = cv('dropdown_mm32cr4w')?.text;
  return {
    status,
    due_date: dueDate,
    owner,
    additional_divisions: additional
      ? additional.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the Monday polling loop. Only takes effect when
 * MONDAY_USE_POLLING=true.
 */
export function startMondayPoller(client: WebClient): void {
  if (process.env.MONDAY_USE_POLLING !== 'true') {
    console.log('[monday-poller] disabled (set MONDAY_USE_POLLING=true to enable)');
    return;
  }

  const tick = async () => {
    try {
      const items = await fetchChangedItems();
      let emitted = 0;
      for (const item of items) {
        const snapshot = snapshotFromItem(item);
        const prev = lastSeen.get(item.id);
        const events = diffSnapshots(prev, snapshot);
        for (const event of events) {
          await composeAndPostLifecycleReply({
            client,
            mondayItemId: item.id,
            event,
          });
          emitted++;
        }
        lastSeen.set(item.id, snapshot);
      }
      await logRequestEvent({
        eventType: 'poller_tick',
        parsedFields: { items_checked: items.length, events_emitted: emitted },
      });
    } catch (err) {
      console.error('[monday-poller] tick failed:', err);
      await trackError(err, undefined, { source: 'monday-poller' });
    }
  };

  // Prime the cache so the first tick doesn't fire false events.
  fetchChangedItems()
    .then((items) => {
      for (const item of items) {
        lastSeen.set(item.id, snapshotFromItem(item));
      }
      console.log(`[monday-poller] primed cache with ${items.length} items`);
    })
    .catch((err) => console.error('[monday-poller] prime failed:', err));

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[monday-poller] tick error:', err));
  }, POLL_INTERVAL_MS);
}

export function stopMondayPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
