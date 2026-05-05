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
 * channel is not configured as an intake channel.
 *
 * Note: alerts and test channels return null — they don't belong to a
 * single division. Callers that need division info should only call this
 * after confirming the channel role is 'intake'.
 */
export function divisionForChannel(channelId: string): Division | null {
  const entry = loadConfig().get(channelId);
  if (!entry || entry.role !== 'intake') return null;
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
 * Test-only: clears the in-memory cache so the next call re-reads the file.
 * Used by unit tests that swap out the config path or content between cases.
 */
export function _resetCacheForTesting(): void {
  cachedConfig = null;
  cachedMtimeMs = null;
}
