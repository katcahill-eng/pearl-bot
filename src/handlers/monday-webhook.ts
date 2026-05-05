/**
 * Sage v2 Monday webhook receiver.
 *
 * Per PRD US-017:
 *   - First POST is a challenge handshake — echo the challenge back.
 *   - Subsequent POSTs carry change events (status, column, update).
 *   - Each event is normalized to a LifecycleEvent and passed to
 *     composeAndPostLifecycleReply.
 *
 * If the Monday plan doesn't support webhooks, the polling fallback
 * (US-018) covers the same ground at a 5-minute lag.
 *
 * Wired into the existing http server in src/lib/webhook.ts.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { WebClient } from '@slack/web-api';
import { composeAndPostLifecycleReply, type LifecycleEvent } from '../lib/lifecycle-composer';
import { trackError } from '../lib/error-tracker';

interface MondayWebhookPayload {
  challenge?: string;
  event?: {
    type?: string;
    boardId?: number;
    pulseId?: number | string;
    columnId?: string;
    columnTitle?: string;
    value?: any;
    previousValue?: any;
    textValue?: string;
    previousTextValue?: string;
  };
}

/**
 * Read JSON body from an incoming HTTP request. Best-effort — assumes
 * body fits in memory (Monday webhook payloads are <10KB in practice).
 */
function readJsonBody(req: IncomingMessage): Promise<MondayWebhookPayload> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function normalizeMondayEvent(payload: MondayWebhookPayload): LifecycleEvent | null {
  const evt = payload.event;
  if (!evt) return null;

  const columnId = evt.columnId ?? '';
  const columnTitle = evt.columnTitle ?? '';

  // Status column changes (any status_*).
  if (columnId === 'status' || columnTitle === 'Status') {
    const newLabel = evt.value?.label?.text ?? evt.textValue ?? null;
    const oldLabel = evt.previousValue?.label?.text ?? evt.previousTextValue ?? null;
    if (!newLabel) return null;
    return {
      kind: 'status_change',
      oldStatus: oldLabel,
      newStatus: newLabel,
    };
  }

  // Due date changes.
  if (columnId === 'date' || columnTitle === 'Due Date') {
    const newDate = evt.value?.date ?? evt.textValue ?? null;
    if (!newDate) return null;
    return {
      kind: 'due_date_changed',
      newDate,
    };
  }

  // Owner changes (people column).
  if (columnTitle === 'Owner' || columnId === 'person') {
    const ownerName = evt.value?.personsAndTeams?.[0]?.name ?? evt.textValue ?? '';
    if (!ownerName) return null;
    return { kind: 'owner_changed', ownerName };
  }

  // Additional Divisions Impacted changes.
  if (columnId === 'dropdown_mm32cr4w' || columnTitle === 'Additional Divisions Impacted') {
    const labels: string[] = Array.isArray(evt.value?.chosenValues)
      ? evt.value.chosenValues.map((c: any) => c?.name).filter(Boolean)
      : (evt.textValue ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { kind: 'additional_divisions_changed', divisions: labels };
  }

  return null;
}

export async function handleMondayWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  client: WebClient,
): Promise<void> {
  let payload: MondayWebhookPayload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid JSON');
    return;
  }

  // Challenge handshake — echo {challenge} on first POST.
  if (payload.challenge) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ challenge: payload.challenge }));
    return;
  }

  // Acknowledge fast — Monday retries on slow responses.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));

  try {
    const event = normalizeMondayEvent(payload);
    if (!event) return;

    const mondayItemId = String(payload.event?.pulseId ?? '');
    if (!mondayItemId) return;

    await composeAndPostLifecycleReply({ client, mondayItemId, event });
  } catch (err) {
    console.error('[monday-webhook] event handling failed:', err);
    await trackError(err, undefined, { source: 'monday-webhook' });
  }
}
