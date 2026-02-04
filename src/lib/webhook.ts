import http from 'http';
import type { WebClient } from '@slack/web-api';
import { config } from './config';
import type { CollectedData } from './conversation';
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
      // Only accept POST /webhook/intake
      if (req.method === 'POST' && req.url === '/webhook/intake') {
        await handleIntakeWebhook(req, res, slackClient);
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
      const projectName =
        collectedData.context_background?.slice(0, 80) ??
        collectedData.deliverables[0] ??
        'Untitled Request';
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
