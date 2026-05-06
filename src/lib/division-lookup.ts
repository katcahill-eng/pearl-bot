/**
 * Channel-to-division-and-role lookup for Sage v2.
 *
 * Reads src/config/channels.yaml on first call. Maps each Slack channel
 * configured for Sage to (a) the role it plays — intake, alerts, or test —
 * and (b) for intake channels, the Pearl division it belongs to.
 *
 * Used by the channel router to decide what to do when @Sage is mentioned.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type Division =
  | 'BD'
  | 'P2'
  | 'CX/Core'
  | 'Corporate'
  | 'Product'
  | 'Marketing';

export type ChannelRole = 'intake' | 'alerts' | 'test';

interface ChannelConfigEntry {
  channel_id: string;
  channel_name: string;
  role: ChannelRole;
  division?: Division;
}

interface ChannelsYaml {
  channels: ChannelConfigEntry[];
}

const CONFIG_PATH = path.resolve(__dirname, '../config/channels.yaml');

let cachedConfig: Map<string, ChannelConfigEntry> | null = null;
let cachedMtimeMs: number | null = null;

function loadConfig(): Map<string, ChannelConfigEntry> {
  const stat = fs.statSync(CONFIG_PATH);
  if (cachedConfig && cachedMtimeMs === stat.mtimeMs) {
    return cachedConfig;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) as ChannelsYaml | null;

  if (!parsed || !Array.isArray(parsed.channels)) {
    throw new Error(
      `[division-lookup] ${CONFIG_PATH} is missing a top-level 'channels' array`,
    );
  }

  const map = new Map<string, ChannelConfigEntry>();
  for (const entry of parsed.channels) {
    if (!entry.channel_id || !entry.role) {
      throw new Error(
        `[division-lookup] channels.yaml entry missing channel_id or role: ${JSON.stringify(entry)}`,
      );
    }
    if (entry.role === 'intake' && !entry.division) {
      throw new Error(
        `[division-lookup] intake channel '${entry.channel_name ?? entry.channel_id}' missing division`,
      );
    }
    map.set(entry.channel_id, entry);
  }

  cachedConfig = map;
  cachedMtimeMs = stat.mtimeMs;
  return map;
}

/**
 * Returns the Pearl division for the given Slack channel, or null if the
 * channel is not configured or has no division set.
 *
 * Test channels MAY carry an explicit division so they can run the full
 * submission flow (otherwise view-submission bails). Alerts channels
 * normally don't have a division and return null.
 */
export function divisionForChannel(channelId: string): Division | null {
  const entry = loadConfig().get(channelId);
  if (!entry) return null;
  return entry.division ?? null;
}

/**
 * Returns the role of the given Slack channel (intake, alerts, or test),
 * or null if the channel is not configured for Sage.
 */
export function roleForChannel(channelId: string): ChannelRole | null {
  const entry = loadConfig().get(channelId);
  return entry?.role ?? null;
}

/**
 * Returns all configured channel IDs that match a given role.
 * Useful for finding the alerts channel without hard-coding its ID
 * in handler code.
 */
export function findChannelsByRole(role: ChannelRole): string[] {
  const out: string[] = [];
  for (const [id, entry] of loadConfig().entries()) {
    if (entry.role === role) out.push(id);
  }
  return out;
}

/**
 * Test-only: clears the in-memory cache so the next call re-reads the file.
 * Used by unit tests that swap out the config path or content between cases.
 */
export function _resetCacheForTesting(): void {
  cachedConfig = null;
  cachedMtimeMs = null;
}
