import http from 'http';
import { getRecentErrors, getImprovements, updateImprovementStatus, getRecentUnrecognizedMessages, getConversationMetricsSummary } from './db';
import { sendDailyDigest } from './daily-digest';

// --- In-memory ring buffer for recent logs (readable via GET /debug/logs) ---
const LOG_BUFFER_SIZE = 2000;
const logBuffer: string[] = [];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args: any[]) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logBuffer.push(`${new Date().toISOString()} [LOG] ${msg}`);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalConsoleLog.apply(console, args);
};

console.error = (...args: any[]) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logBuffer.push(`${new Date().toISOString()} [ERR] ${msg}`);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalConsoleError.apply(console, args);
};

export function getRecentLogs(): string[] {
  return [...logBuffer];
}
import type { WebClient } from '@slack/web-api';
import { config } from './config';
import { generateProjectName, type CollectedData } from './conversation';
import { classifyRequest, type RequestClassification } from './claude';
import { createMondayItemForReview } from './workflow';
import { buildNotificationMessage } from './notifications';

// --- Types ---

/** Shape of the incoming POST body from the intake form. */
interface FormSubmission {
  name: string;
  email?: string;
  slack_username?: string;
  department: string;
  target: string;
  context_background: string;
  desired_outcomes: string;
  deliverables: string | string[];
  due_date: string;
  approvals?: string;
  constraints?: string;
  supporting_links?: string | string[];
}

// --- Public API ---

/**
 * Start the webhook HTTP server on the specified port.
 * Exposes POST /webhook/intake for form submissions.
 */
export function startWebhookServer(opts: {
  port: number;
  slackClient: WebClient;
}): http.Server {
  const { port, slackClient } = opts;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      } else if (req.method === 'POST' && req.url === '/webhook/intake') {
        await handleIntakeWebhook(req, res, slackClient);
      } else if (req.method === 'GET' && req.url === '/debug/logs') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(getRecentLogs().join('\n'));
      } else if (req.method === 'GET' && req.url?.startsWith('/debug/db')) {
        // Quick debug: dump recent conversations using raw pg
        const pg = await import('pg');
        const debugPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined });
        try {
          const convos = await debugPool.query(
            `SELECT id, user_id, thread_ts, status, current_step, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 15`
          );
          const dedup = await debugPool.query(
            `SELECT message_ts FROM message_dedup ORDER BY message_ts DESC LIMIT 20`
          );
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(
            '=== CONVERSATIONS (last 15) ===\n' +
            convos.rows.map((r: any) => `id=${r.id} thread=${r.thread_ts} status=${r.status} step=${r.current_step} updated=${r.updated_at}`).join('\n') +
            '\n\n=== MESSAGE_DEDUP (last 20) ===\n' +
            dedup.rows.map((r: any) => r.message_ts).join('\n')
          );
        } finally { await debugPool.end(); }
      } else if (req.method === 'GET' && req.url?.startsWith('/debug/errors')) {
        const errors = await getRecentErrors(24, 50);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        if (errors.length === 0) {
          res.end('No errors in the last 24 hours.');
        } else {
          const lines = errors.map((e) =>
            `[${e.count}x] ${e.message}\n    Last seen: ${e.last_seen}\n    Context: ${JSON.stringify(e.last_context)}\n`
          );
          res.end(`=== ERRORS (last 24h, ${errors.length} unique) ===\n\n${lines.join('\n')}`);
        }
      } else if (req.method === 'POST' && req.url === '/debug/digest') {
        await sendDailyDigest(slackClient);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Digest sent' }));
      } else if (req.method === 'POST' && req.url?.match(/^\/debug\/improvements\/(\d+)\/(dismiss|apply)$/)) {
        const match = req.url.match(/^\/debug\/improvements\/(\d+)\/(dismiss|apply)$/);
        const id = parseInt(match![1], 10);
        const action = match![2] as 'dismiss' | 'apply';
        const status = action === 'dismiss' ? 'dismissed' : 'applied';
        await updateImprovementStatus(id, status, 'claude-code');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id, status }));
      } else if (req.method === 'GET' && req.url?.startsWith('/debug/improvements')) {
        const improvements = await getImprovements();
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        if (improvements.length === 0) {
          res.end('No improvement suggestions yet.');
        } else {
          const grouped: Record<string, typeof improvements> = {};
          for (const imp of improvements) {
            (grouped[imp.status] ??= []).push(imp);
          }
          const sections = Object.entries(grouped).map(([status, items]) => {
            const lines = items.map((i) =>
              `  [#${i.id}] [${i.category}] ${i.summary}\n    ${i.details.substring(0, 200)}${i.details.length > 200 ? '...' : ''}\n    Created: ${i.created_at}${i.applied_by ? `\n    Applied by: ${i.applied_by} at ${i.applied_at}` : ''}`
            );
            return `=== ${status.toUpperCase()} (${items.length}) ===\n${lines.join('\n\n')}`;
          });
          res.end(sections.join('\n\n'));
        }
      } else if (req.method === 'GET' && req.url?.startsWith('/debug/metrics')) {
        const [metrics, unrecognized] = await Promise.all([
          getConversationMetricsSummary(7),
          getRecentUnrecognizedMessages(7, 50),
        ]);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const lines: string[] = [
          `=== CONVERSATION METRICS (last 7 days) ===`,
          `Total conversations: ${metrics.total}`,
          `Avg duration: ${metrics.avgDurationSeconds ? `${Math.round(metrics.avgDurationSeconds)}s` : 'N/A'}`,
          `By status: ${JSON.stringify(metrics.byStatus)}`,
          `By classification: ${JSON.stringify(metrics.byClassification)}`,
          '',
          `=== UNRECOGNIZED MESSAGES (last 7 days, ${unrecognized.length} total) ===`,
        ];
        // Group by step
        const byStep: Record<string, number> = {};
        for (const m of unrecognized) {
          const step = m.current_step ?? 'unknown';
          byStep[step] = (byStep[step] ?? 0) + 1;
        }
        for (const [step, count] of Object.entries(byStep)) {
          lines.push(`  ${step}: ${count}`);
        }
        if (unrecognized.length > 0) {
          lines.push('', 'Recent examples:');
          for (const m of unrecognized.slice(0, 10)) {
            lines.push(`  [${m.current_step ?? '?'}] "${m.user_message.substring(0, 80)}" (confidence=${m.confidence}, fallback=${m.raw_fallback_used})`);
          }
        }
        res.end(lines.join('\n'));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error('[webhook] Unhandled error in webhook server:', err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  server.listen(port, () => {
    console.log(`🔗 Webhook server listening on port ${port}`);
  });

  return server;
}

// --- Private helpers ---

async function handleIntakeWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  slackClient: WebClient,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read request body' }));
    return;
  }

  let formData: FormSubmission;
  try {
    formData = JSON.parse(body) as FormSubmission;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // Validate required fields
  if (!formData.name || !formData.context_background || !formData.department) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Missing required fields: name, context_background, department',
      }),
    );
    return;
  }

  // Map form fields to CollectedData
  const collectedData: CollectedData = {
    requester_name: formData.name,
    requester_department: formData.department,
    target: formData.target ?? null,
    context_background: formData.context_background,
    desired_outcomes: formData.desired_outcomes ?? null,
    deliverables: normalizeArray(formData.deliverables),
    due_date: formData.due_date ?? null,
    due_date_parsed: null,
    approvals: formData.approvals ?? null,
    constraints: formData.constraints ?? null,
    supporting_links: normalizeArray(formData.supporting_links),
    request_type: null,
    additional_details: {},
    conference_start_date: null,
    conference_end_date: null,
    presenter_names: null,
    outside_presenters: null,
  };

  // Classify the request using the same logic as conversation flow
  const classification: RequestClassification = classifyRequest(collectedData);
  const effectiveClassification: 'quick' | 'full' =
    classification === 'undetermined' ? 'quick' : classification;

  // Determine requester info
  const requesterName = formData.name;

  console.log(`[webhook] Processing form submission from ${requesterName} (${formData.email ?? 'no email'})`);

  // Create Monday.com item with "Under Review" status (form submissions also go through approval)
  let mondayResult;
  try {
    mondayResult = await createMondayItemForReview({
      collectedData,
      classification: effectiveClassification,
      requesterName,
      channelId: '',
      threadTs: '',
    });
  } catch (err) {
    console.error('[webhook] Monday.com item creation failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to create Monday.com item. Please try again or contact the marketing team.' }));
    return;
  }

  // Post notification to #marketing-requests channel
  const marketingChannelId = config.slackMarketingChannelId;
  if (marketingChannelId && mondayResult.success) {
    try {
      const projectName = generateProjectName(collectedData);
      const result = {
        success: true,
        mondayUrl: mondayResult.boardUrl,
        errors: [] as string[],
      };
      const notification = buildNotificationMessage({
        projectName,
        classification: effectiveClassification,
        collectedData,
        requesterName,
        result,
      });
      await slackClient.chat.postMessage({
        channel: marketingChannelId,
        text: notification,
      });
    } catch (err) {
      console.error('[webhook] Failed to post notification to marketing channel:', err);
    }
  }

  // DM the user if slack_username is provided
  if (formData.slack_username) {
    try {
      const dmResult = await slackClient.conversations.open({
        users: formData.slack_username,
      });
      if (dmResult.channel?.id) {
        await slackClient.chat.postMessage({
          channel: dmResult.channel.id,
          text: `:clipboard: *Your form submission has been received!*\n\nYour request is now under review by the marketing team. You'll be notified once it's been approved.`,
        });
      }
    } catch (err) {
      console.error('[webhook] Failed to DM user:', err);
    }
  }

  // Return success response
  res.writeHead(mondayResult.success ? 200 : 207, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      success: mondayResult.success,
      mondayUrl: mondayResult.boardUrl ?? null,
      mondayItemId: mondayResult.itemId ?? null,
      errors: mondayResult.error ? [mondayResult.error] : [],
    }),
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Normalize a field that may be a string (comma-separated) or already an array.
 */
function normalizeArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
