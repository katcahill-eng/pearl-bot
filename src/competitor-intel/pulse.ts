/**
 * Competitor Intelligence — DAILY PULSE (the "don't make me wait a week" path).
 *
 * Runs every weekday morning. Lightweight: detects MATERIAL change since the last
 * check and alerts immediately to Slack. No deck, no full synthesis — that's the
 * Monday briefing's job (run.ts).
 *
 * Alert bar (per Kat): material moves (funding, M&A, product/pricing launches,
 * major partnerships, big coverage) + ranking/AI-visibility shifts.
 *
 * Dedup: every alerted event is logged to the Sheet's Events tab by a stable key;
 * we never alert the same thing twice.
 *
 * Scheduled via a Railway cron service (Mon-Fri AM). Manual: npm run competitor-intel:pulse
 */

import { collectCompetitorNews, collectThemes } from './collect';
import { runAiVisibility } from './sources/ai-visibility';
import { extractMaterialEvents, detectAiShifts } from './detect';
import {
  ensureSheet,
  readSeenEventKeys,
  appendEvents,
  readLatestAiVisibility,
} from './sinks/sheet';
import { postAlerts } from './sinks/slack';
import type { MaterialEvent } from './types';

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function runPulse(): Promise<void> {
  const detected = today();
  console.log(`[pulse] starting daily pulse for ${detected}`);

  // Day-fresh research (recency=1) — competitor news + standing themes
  const [competitorNews, themes, aiVisibility] = await Promise.all([
    collectCompetitorNews(1),
    collectThemes(1),
    runAiVisibility(),
  ]);

  // Material events from the news; AI shifts vs. last recorded baseline
  const sheetId = await ensureSheet();
  const priorAi = await readLatestAiVisibility(sheetId);
  const [newsEvents, aiEvents] = await Promise.all([
    extractMaterialEvents([...competitorNews, ...themes]),
    Promise.resolve(detectAiShifts(aiVisibility, priorAi)),
  ]);

  // Dedup against everything we've already alerted
  const seen = await readSeenEventKeys(sheetId);
  const fresh: MaterialEvent[] = [];
  const localSeen = new Set<string>();
  for (const e of [...newsEvents, ...aiEvents]) {
    if (seen.has(e.dedupKey) || localSeen.has(e.dedupKey)) continue;
    localSeen.add(e.dedupKey);
    fresh.push(e);
  }

  console.log(
    `[pulse] ${newsEvents.length} news + ${aiEvents.length} AI-shift candidates → ${fresh.length} fresh after dedup`,
  );

  if (!fresh.length) {
    console.log('[pulse] nothing new — staying quiet.');
    return;
  }

  // Alert + record (record AFTER posting so a Slack failure doesn't suppress retry)
  await postAlerts(fresh);
  await appendEvents(sheetId, detected, fresh);
  console.log(`[pulse] alerted ${fresh.length} event(s) and logged them.`);
}

if (require.main === module) {
  runPulse()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[pulse] run failed:', err);
      process.exit(1);
    });
}
