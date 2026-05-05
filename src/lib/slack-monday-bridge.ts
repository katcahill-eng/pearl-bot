/**
 * Slack-user → Monday-user resolution.
 *
 * Sage v2 modal submissions store users as Slack IDs but Monday's People
 * column needs Monday user IDs. The bridge:
 *   1. Slack client.users.info → email
 *   2. monday.ts findMondayUserByEmail → Monday user ID
 *   3. Returns id or null (caller decides how to handle absence).
 *
 * The result is cached in-memory per-process for the cache TTL since
 * email-to-monday-id mappings change rarely.
 */

import type { WebClient } from '@slack/web-api';
import { findMondayUserByEmail } from './monday';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map<string, { value: number | null; expiresAt: number }>();

export async function resolveMondayUserId(
  slackUserId: string,
  client: WebClient,
): Promise<number | null> {
  const cached = cache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let mondayUserId: number | null = null;
  try {
    const info = await client.users.info({ user: slackUserId });
    const email = info.user?.profile?.email;
    if (email) {
      mondayUserId = await findMondayUserByEmail(email);
    }
  } catch (err) {
    console.error(`[slack-monday-bridge] Failed to resolve Slack user ${slackUserId}:`, err);
  }

  cache.set(slackUserId, { value: mondayUserId, expiresAt: Date.now() + CACHE_TTL_MS });
  return mondayUserId;
}

/**
 * Resolve multiple Slack user IDs to Monday user IDs in parallel.
 * Returns only the IDs that resolved successfully.
 */
export async function resolveMondayUserIds(
  slackUserIds: string[],
  client: WebClient,
): Promise<number[]> {
  const resolved = await Promise.all(
    slackUserIds.map((id) => resolveMondayUserId(id, client)),
  );
  return resolved.filter((id): id is number => id !== null);
}

/**
 * Get the Slack display name for a user (used in confirmation/alert messages).
 */
export async function getSlackDisplayName(
  slackUserId: string,
  client: WebClient,
): Promise<string> {
  try {
    const info = await client.users.info({ user: slackUserId });
    const profile = info.user?.profile;
    return profile?.display_name || profile?.real_name || slackUserId;
  } catch {
    return slackUserId;
  }
}
