import type { WebClient } from '@slack/web-api';
import { config } from './config';
import { logError } from './db';

/**
 * Native error tracker — logs errors to PostgreSQL and DMs the marketing lead
 * on Slack when the same error spikes (3+ times in an hour).
 *
 * No external service needed. Errors are stored in the error_log table and
 * viewable via the /debug/errors endpoint.
 */

// Track which error keys we've already alerted on this hour to avoid spam
const alertedKeys = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const SPIKE_THRESHOLD = 3; // DM after 3 occurrences of the same error in 1 hour

/**
 * Track an error: log to DB, and DM the marketing lead if it's spiking.
 */
export async function trackError(
  error: unknown,
  slackClient?: WebClient,
  context?: Record<string, string>,
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  const errorKey = (err.stack?.split('\n')[0] ?? err.message).substring(0, 200);

  // Log to DB
  const count = await logError(error, context);

  // Check if we should alert
  if (count >= SPIKE_THRESHOLD && slackClient) {
    const lastAlerted = alertedKeys.get(errorKey) ?? 0;
    if (Date.now() - lastAlerted > ALERT_COOLDOWN_MS) {
      alertedKeys.set(errorKey, Date.now());
      await sendErrorAlert(slackClient, err, count, context);
    }
  }

  // Periodically clean the alertedKeys map to prevent memory leak
  if (alertedKeys.size > 100) {
    const cutoff = Date.now() - ALERT_COOLDOWN_MS;
    for (const [key, ts] of alertedKeys) {
      if (ts < cutoff) alertedKeys.delete(key);
    }
  }
}

async function sendErrorAlert(
  client: WebClient,
  error: Error,
  count: number,
  context?: Record<string, string>,
): Promise<void> {
  const contextStr = context ? Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none';
  const message = [
    `:rotating_light: *Error spike detected* (${count}x in the last hour)`,
    '',
    `*Error:* \`${error.message}\``,
    `*Context:* ${contextStr}`,
    '',
    `_View all errors: https://pearl-bot-production.up.railway.app/debug/errors_`,
  ].join('\n');

  try {
    await client.chat.postMessage({
      channel: config.marketingLeadSlackId,
      text: message,
    });
    console.log(`[error-tracker] Sent spike alert for: ${error.message.substring(0, 60)}`);
  } catch (dmErr) {
    console.error('[error-tracker] Failed to send error alert DM:', dmErr);
  }
}
