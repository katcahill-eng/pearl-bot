import { logError } from './db';

/**
 * Native error tracker — logs errors to PostgreSQL for debugging.
 * Errors are viewable via /debug/errors endpoint.
 * No DMs, no alerts — Claude checks this endpoint at the start of sessions.
 */
export async function trackError(
  error: unknown,
  _slackClient?: unknown,
  context?: Record<string, string>,
): Promise<void> {
  await logError(error, context);
}
