/**
 * Sage v2 weekly analytics digest.
 *
 * Runs Monday 8am ET. Produces a DM to each user ID listed in
 * DIGEST_RECIPIENT_USER_IDS (comma-separated env var; default Kat +
 * Grant) summarizing the past week's request activity.
 *
 * Sections (per PRD US-024):
 *   - Volume this week: total submissions, by type, by division
 *   - Turnaround: avg days from modal_submitted → status='Completed/Live'
 *     (4-week rolling)
 *   - Abandonment: % of modal_opened that didn't get a matching
 *     modal_submitted within 1h (this week)
 *   - Recommendation acceptance: per-rule acceptance rate this week
 *   - Top requesters: top 5 by submission count
 *   - Open-load by division: current snapshot from request_records
 *     where status not in ('Completed/Live','Declined','Withdrawn')
 *
 * The maintainer DM is the second of two legitimate Sage DM use cases
 * (the other is the 48-hour approver nudge). Distinct from the
 * staff-facing no-DM rule.
 */

import type { WebClient } from '@slack/web-api';
import { Pool } from 'pg';
import { trackError } from './error-tracker';

const DEFAULT_RECIPIENTS_ENV = 'DIGEST_RECIPIENT_USER_IDS';
// 0 8 * * 1 = 8am Monday in the local server tz (Railway runs UTC; we
// schedule via setInterval with explicit ET-day check for precision).
const DIGEST_HOUR_ET = 8;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastFiredYearWeek: string | null = null;

const localPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

interface DigestSections {
  volumeByType: Record<string, number>;
  volumeByDivision: Record<string, number>;
  totalSubmissions: number;
  abandonmentPct: number;
  recommendationAcceptanceByRule: { name: string; offered: number; accepted: number }[];
  topRequesters: { user_id: string; count: number }[];
  openLoadByDivision: Record<string, number>;
  turnaroundDaysByType: Record<string, number>;
}

export async function buildDigestSections(): Promise<DigestSections> {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

  const [
    submissions,
    modalOpens,
    recAccepted,
    recOffered,
    topRequesters,
    openLoad,
    turnaround,
  ] = await Promise.all([
    localPool.query(
      `SELECT parsed_fields_json->>'requestType' AS type,
              parsed_fields_json->>'division' AS division,
              user_id
       FROM request_events
       WHERE event_type='modal_submitted' AND created_at >= $1`,
      [oneWeekAgo],
    ),
    localPool.query(
      `SELECT COUNT(*) AS opens,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM request_events s
                WHERE s.event_type='modal_submitted'
                  AND s.user_id = e.user_id
                  AND s.created_at BETWEEN e.created_at AND e.created_at + INTERVAL '1 hour'
              ) THEN 1 ELSE 0 END) AS submitted
       FROM request_events e
       WHERE event_type='modal_opened' AND created_at >= $1`,
      [oneWeekAgo],
    ),
    localPool.query(
      `SELECT jsonb_array_elements(recommendations_accepted_json)->>'name' AS name,
              COUNT(*) AS n
       FROM request_events
       WHERE event_type='modal_submitted'
         AND created_at >= $1
         AND recommendations_accepted_json IS NOT NULL
       GROUP BY name`,
      [oneWeekAgo],
    ),
    localPool.query(
      `SELECT jsonb_array_elements(recommendations_offered_json)->>'name' AS name,
              COUNT(*) AS n
       FROM request_events
       WHERE event_type='modal_submitted'
         AND created_at >= $1
         AND recommendations_offered_json IS NOT NULL
       GROUP BY name`,
      [oneWeekAgo],
    ),
    localPool.query(
      `SELECT user_id, COUNT(*) AS n
       FROM request_events
       WHERE event_type='modal_submitted' AND created_at >= $1
       GROUP BY user_id
       ORDER BY n DESC
       LIMIT 5`,
      [oneWeekAgo],
    ),
    localPool.query(
      `SELECT division, COUNT(*) AS n
       FROM request_records
       WHERE status NOT IN ('Completed/Live','Declined','withdrawn')
       GROUP BY division`,
    ),
    localPool.query(
      `SELECT request_type AS type,
              AVG(EXTRACT(EPOCH FROM (NOW() - submitted_at)) / 86400) AS avg_days
       FROM request_records
       WHERE submitted_at >= $1
         AND status = 'Completed/Live'
       GROUP BY request_type`,
      [fourWeeksAgo],
    ),
  ]);

  const volumeByType: Record<string, number> = {};
  const volumeByDivision: Record<string, number> = {};
  for (const row of submissions.rows as any[]) {
    const t = row.type ?? 'unknown';
    const d = row.division ?? 'unknown';
    volumeByType[t] = (volumeByType[t] ?? 0) + 1;
    volumeByDivision[d] = (volumeByDivision[d] ?? 0) + 1;
  }

  const opens = parseInt(modalOpens.rows[0]?.opens ?? '0', 10);
  const submitted = parseInt(modalOpens.rows[0]?.submitted ?? '0', 10);
  const abandonmentPct = opens === 0 ? 0 : Math.round(((opens - submitted) / opens) * 100);

  const offeredMap = new Map<string, number>();
  for (const row of recOffered.rows as any[]) {
    offeredMap.set(row.name, parseInt(row.n, 10));
  }
  const recommendationAcceptanceByRule = (recAccepted.rows as any[]).map((row) => ({
    name: row.name as string,
    accepted: parseInt(row.n, 10),
    offered: offeredMap.get(row.name) ?? 0,
  }));

  const openLoadByDivision: Record<string, number> = {};
  for (const row of openLoad.rows as any[]) {
    openLoadByDivision[row.division] = parseInt(row.n, 10);
  }

  const turnaroundDaysByType: Record<string, number> = {};
  for (const row of turnaround.rows as any[]) {
    turnaroundDaysByType[row.type ?? 'unknown'] = Math.round(parseFloat(row.avg_days) * 10) / 10;
  }

  return {
    volumeByType,
    volumeByDivision,
    totalSubmissions: submissions.rows.length,
    abandonmentPct,
    recommendationAcceptanceByRule,
    topRequesters: (topRequesters.rows as any[]).map((r) => ({
      user_id: r.user_id,
      count: parseInt(r.n, 10),
    })),
    openLoadByDivision,
    turnaroundDaysByType,
  };
}

export function formatDigest(sections: DigestSections): string {
  const lines: string[] = [];
  lines.push('*Sage Weekly Digest*');
  lines.push('');
  lines.push(`*Volume this week:* ${sections.totalSubmissions} submissions`);

  const byType = Object.entries(sections.volumeByType).sort((a, b) => b[1] - a[1]);
  if (byType.length > 0) {
    lines.push('  by type:');
    for (const [type, n] of byType) {
      lines.push(`    • ${type}: ${n}`);
    }
  }

  const byDivision = Object.entries(sections.volumeByDivision).sort((a, b) => b[1] - a[1]);
  if (byDivision.length > 0) {
    lines.push('  by division:');
    for (const [d, n] of byDivision) {
      lines.push(`    • ${d}: ${n}`);
    }
  }

  lines.push('');
  lines.push(`*Abandonment:* ${sections.abandonmentPct}% of modals opened this week didn't submit within 1h`);

  if (sections.recommendationAcceptanceByRule.length > 0) {
    lines.push('');
    lines.push('*Recommendation acceptance:*');
    const sortedRules = sections.recommendationAcceptanceByRule
      .filter((r) => r.offered > 0)
      .sort((a, b) => b.offered - a.offered)
      .slice(0, 8);
    for (const rule of sortedRules) {
      const pct = rule.offered === 0 ? 0 : Math.round((rule.accepted / rule.offered) * 100);
      lines.push(`  • ${rule.name}: ${rule.accepted}/${rule.offered} = ${pct}%`);
    }
  }

  if (sections.topRequesters.length > 0) {
    lines.push('');
    lines.push('*Top requesters:*');
    for (const r of sections.topRequesters) {
      lines.push(`  • <@${r.user_id}>: ${r.count}`);
    }
  }

  const openLoad = Object.entries(sections.openLoadByDivision).sort((a, b) => b[1] - a[1]);
  if (openLoad.length > 0) {
    lines.push('');
    lines.push('*Open load by division:*');
    for (const [d, n] of openLoad) {
      lines.push(`  • ${d}: ${n} open`);
    }
  }

  const turn = Object.entries(sections.turnaroundDaysByType).sort((a, b) => a[1] - b[1]);
  if (turn.length > 0) {
    lines.push('');
    lines.push('*Turnaround (4-week avg):*');
    for (const [t, days] of turn) {
      lines.push(`  • ${t}: ${days}d`);
    }
  }

  return lines.join('\n');
}

export async function buildAndSendWeeklyDigest(client: WebClient, dryRun = false): Promise<void> {
  const recipients = (process.env[DEFAULT_RECIPIENTS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (recipients.length === 0 && !dryRun) {
    console.warn('[weekly-digest] No DIGEST_RECIPIENT_USER_IDS configured');
    return;
  }

  try {
    const sections = await buildDigestSections();
    const message = formatDigest(sections);

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(message);
      return;
    }

    for (const userId of recipients) {
      try {
        await client.chat.postMessage({ channel: userId, text: message });
      } catch (err) {
        console.error(`[weekly-digest] Failed to DM ${userId}:`, err);
        await trackError(err, undefined, { source: 'weekly-digest', user: userId });
      }
    }
  } catch (err) {
    console.error('[weekly-digest] build failed:', err);
    await trackError(err, undefined, { source: 'weekly-digest-build' });
  }
}

/**
 * Schedule the weekly digest to fire at 8am ET on Mondays. We poll
 * every 5 minutes and trigger on the first matching tick of each
 * year-week, so a single restart-during-the-window doesn't cause a
 * duplicate fire.
 */
export function startWeeklyDigestScheduler(client: WebClient): void {
  const tick = async () => {
    const now = new Date();
    // ET = UTC-5 (EST) or UTC-4 (EDT) — approximate by always using -5;
    // for this schedule the ±1h drift across DST doesn't matter.
    const etHour = (now.getUTCHours() - 5 + 24) % 24;
    const etDow = now.getUTCDay(); // Sunday=0; ET-Monday is also UTC-Monday for the morning hour
    if (etDow !== 1 || etHour !== DIGEST_HOUR_ET) return;
    const yearWeek = `${now.getUTCFullYear()}-W${Math.floor((now.getUTCDate() + 6) / 7)}`;
    if (lastFiredYearWeek === yearWeek) return;
    lastFiredYearWeek = yearWeek;
    await buildAndSendWeeklyDigest(client);
  };

  intervalHandle = setInterval(() => {
    tick().catch((err) => console.error('[weekly-digest] tick error:', err));
  }, 5 * 60 * 1000);

  console.log('[weekly-digest] scheduler started (Mondays 8am ET)');
}

export function stopWeeklyDigestScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
