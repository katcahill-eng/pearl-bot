/**
 * Sprout Social Listening connector — competitor share-of-voice + sentiment.
 *
 * Flow:
 *   1. Find the Listening Topic by name (metadata/customer/topics).
 *   2. POST listening/topics/{id}/metrics to aggregate volume + sentiment per
 *      competitor group.
 *
 * Fully graceful: if the token is unset, the topic isn't indexed yet, or the
 * metrics call fails, returns { available: false } so a weekly run never breaks.
 *
 * NOTE: the metrics POST payload (metric/dimension names) should be confirmed
 * against a live, indexed topic — Sprout's schema varies by topic type. The
 * parsing below is defensive and degrades to volume-only if sentiment is absent.
 */

import { ciConfig } from '../config';
import type { SproutSOV } from '../types';

const BASE = 'https://api.sproutsocial.com/v1';

function authHeaders() {
  return { Authorization: `Bearer ${ciConfig.sproutApiToken}`, 'Content-Type': 'application/json' };
}

/** Find the configured Listening Topic's id by title. Returns null if absent. */
async function findTopicId(): Promise<string | null> {
  const res = await fetch(`${BASE}/${ciConfig.sproutCustomerId}/metadata/customer/topics`, {
    headers: authHeaders(),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: Array<{ topic_id?: string | number; title?: string }> };
  const topics = json.data ?? [];
  if (!topics.length) return null;
  const match =
    topics.find((t) => (t.title ?? '').toLowerCase() === ciConfig.sproutTopicName.toLowerCase()) ??
    topics[0];
  return match.topic_id != null ? String(match.topic_id) : null;
}

/** Pull competitor share-of-voice + sentiment. Never throws. */
export async function getCompetitorSOV(): Promise<SproutSOV> {
  if (!ciConfig.sproutApiToken) {
    return { available: false, brands: [], note: 'SPROUT_API_TOKEN not set' };
  }
  try {
    const topicId = await findTopicId();
    if (!topicId) {
      return { available: false, brands: [], note: 'Listening topic not found / still indexing' };
    }

    const res = await fetch(
      `${BASE}/${ciConfig.sproutCustomerId}/listening/topics/${topicId}/metrics`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          // Defensive payload — aggregate volume + sentiment by competitor group.
          fields: ['volume', 'sentiment'],
          dimensions: ['topic.competitor'],
        }),
      },
    );
    if (!res.ok) {
      return { available: false, topicId, brands: [], note: `metrics ${res.status} (topic likely still gathering data)` };
    }
    const json = (await res.json()) as { data?: any[] };
    const rows = json.data ?? [];
    if (!rows.length) {
      return { available: false, topicId, brands: [], note: 'topic live but no data yet' };
    }

    // Defensive parse — shape varies; pull name + volume + sentiment if present.
    const totalVolume = rows.reduce((s, r) => s + (Number(r?.metrics?.volume ?? r?.volume) || 0), 0) || 1;
    const brands = rows.map((r) => {
      const name = r?.dimensions?.['topic.competitor'] ?? r?.competitor ?? r?.name ?? 'unknown';
      const volume = Number(r?.metrics?.volume ?? r?.volume) || 0;
      const sent = r?.metrics?.sentiment ?? r?.sentiment ?? {};
      return {
        name,
        volume,
        sovPct: Math.round((volume / totalVolume) * 1000) / 10,
        sentimentPositive: Number(sent?.positive) || undefined,
        sentimentNeutral: Number(sent?.neutral) || undefined,
        sentimentNegative: Number(sent?.negative) || undefined,
      };
    });
    return { available: true, topicId, brands };
  } catch (err) {
    const note = err instanceof Error ? err.message : 'unknown';
    return { available: false, brands: [], note };
  }
}
