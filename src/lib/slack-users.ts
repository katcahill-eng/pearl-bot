import type { WebClient } from '@slack/web-api';

// --- Types ---

export interface SlackUser {
  id: string;
  realName: string;
  firstName: string;
  lastName: string;
  displayName: string;
  title: string;
}

export interface ResolvedUser {
  name: string;
  slackId: string;
  displayName: string;
  title: string;
  confidence: 'exact' | 'high';
}

export interface NameResolutionResult {
  resolved: ResolvedUser[];
  ambiguous: { name: string; candidates: { name: string; slackId: string; title: string }[] }[];
  unresolved: string[];
}

// --- Cache ---

let cachedUsers: SlackUser[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Public API ---

/**
 * Fetch all workspace users via Slack's users.list API.
 * Results are cached in memory with a 1-hour TTL.
 */
export async function getWorkspaceUsers(client: WebClient): Promise<SlackUser[]> {
  if (cachedUsers.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedUsers;
  }

  console.log('[slack-users] Fetching workspace user list...');
  const users: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.users.list({
      limit: 200,
      cursor,
    });

    for (const member of result.members ?? []) {
      // Skip bots, deleted users, and Slackbot
      if (member.is_bot || member.deleted || member.id === 'USLACKBOT') continue;

      const profile = member.profile;
      if (!profile) continue;

      users.push({
        id: member.id ?? '',
        realName: profile.real_name ?? member.real_name ?? '',
        firstName: profile.first_name ?? '',
        lastName: profile.last_name ?? '',
        displayName: profile.display_name ?? '',
        title: profile.title ?? '',
      });
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  cachedUsers = users;
  cacheTimestamp = Date.now();
  console.log(`[slack-users] Cached ${users.length} workspace users`);
  return users;
}

/**
 * Resolve a list of names against the workspace user directory.
 * Supports exact full-name matches, first-name matches, and display-name matches.
 */
export function resolveNames(names: string[], users: SlackUser[]): NameResolutionResult {
  const resolved: ResolvedUser[] = [];
  const ambiguous: NameResolutionResult['ambiguous'] = [];
  const unresolved: string[] = [];

  for (const inputName of names) {
    const name = inputName.trim();
    if (!name) continue;

    const nameLower = name.toLowerCase();

    // 1. Exact match on realName
    const exactMatch = users.find((u) => u.realName.toLowerCase() === nameLower);
    if (exactMatch) {
      resolved.push({
        name: exactMatch.realName,
        slackId: exactMatch.id,
        displayName: exactMatch.displayName || exactMatch.realName,
        title: exactMatch.title,
        confidence: 'exact',
      });
      continue;
    }

    // 2. First name match
    const firstNameMatches = users.filter((u) => u.firstName.toLowerCase() === nameLower);
    if (firstNameMatches.length === 1) {
      const match = firstNameMatches[0];
      resolved.push({
        name: match.realName,
        slackId: match.id,
        displayName: match.displayName || match.realName,
        title: match.title,
        confidence: 'high',
      });
      continue;
    }
    if (firstNameMatches.length > 1) {
      ambiguous.push({
        name,
        candidates: firstNameMatches.map((m) => ({
          name: m.realName,
          slackId: m.id,
          title: m.title,
        })),
      });
      continue;
    }

    // 3. Display name match
    const displayMatch = users.find((u) => u.displayName.toLowerCase() === nameLower);
    if (displayMatch) {
      resolved.push({
        name: displayMatch.realName,
        slackId: displayMatch.id,
        displayName: displayMatch.displayName || displayMatch.realName,
        title: displayMatch.title,
        confidence: 'high',
      });
      continue;
    }

    // 4. Partial match on realName (e.g., "John S" matching "John Smith")
    const partialMatches = users.filter((u) =>
      u.realName.toLowerCase().startsWith(nameLower) ||
      u.displayName.toLowerCase().startsWith(nameLower)
    );
    if (partialMatches.length === 1) {
      const match = partialMatches[0];
      resolved.push({
        name: match.realName,
        slackId: match.id,
        displayName: match.displayName || match.realName,
        title: match.title,
        confidence: 'high',
      });
      continue;
    }
    if (partialMatches.length > 1) {
      ambiguous.push({
        name,
        candidates: partialMatches.map((m) => ({
          name: m.realName,
          slackId: m.id,
          title: m.title,
        })),
      });
      continue;
    }

    // No match
    unresolved.push(name);
  }

  return { resolved, ambiguous, unresolved };
}

/**
 * Extract individual names from a free-text approver answer.
 * Handles "John and Sarah", "John, Sarah, and Mike", "John Smith", etc.
 */
export function extractNamesFromText(text: string): string[] {
  // Remove common filler words
  let cleaned = text
    .replace(/\b(needs?\s*to|should|will|must|has\s*to)\s*(approve|sign\s*off|review)\b/gi, '')
    .replace(/\b(the|my|our|their|final|deliverables?|assets?|work|project|results?)\b/gi, '')
    .replace(/\b(from|in|at|on|for|of)\s+\w+\b/gi, '')  // "from BD", "in Product"
    .trim();

  // Split on common delimiters: comma, "and", "&", semicolon
  const parts = cleaned
    .split(/[,;&]|\band\b/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length < 50);  // Sanity check on length

  // Further cleanup: remove any remaining non-name words
  return parts
    .map((p) => p.replace(/^\s*(also|plus|maybe)\s*/i, '').trim())
    .filter((p) => p.length > 1 && /[a-zA-Z]/.test(p));
}

/** Clear the user cache (useful for testing). */
export function clearUserCache(): void {
  cachedUsers = [];
  cacheTimestamp = 0;
}
