/**
 * Competitor Intelligence spoke — weekly entry point.
 *
 * Run order:
 *   1. Collect — Perplexity sweeps (competitor news, themes, new entrants)
 *   2. Quant   — SEMrush snapshots + AI-answer visibility probes
 *   3. Synthesize — Claude turns it all into board-ready output
 *   4. Persist — append the week to the data Sheet (system of record)
 *   5. Render  — generate the dated board deck in the folder
 *   6. Deliver — post the drop to the marketing-staff-only Slack channel
 *
 * Scheduled via a Railway cron service (Mondays ~9am ET). Safe to run manually:
 *   npm run competitor-intel
 */

import { loadWatchlist } from './watchlist';
import { collectCompetitorNews, collectThemes, scoutNewEntrants } from './collect';
import { snapshot } from './sources/semrush';
import { runAiVisibility } from './sources/ai-visibility';
import { getCompetitorSOV } from './sources/sprout';
import { corroborate } from './nodes/corroborate';
import { designDeck } from './nodes/deck-design';
import { synthesize } from './synthesize';
import { ensureSheet, writeWeek, readLatestTake } from './sinks/sheet';
import { buildDeck } from './sinks/slides';
import { postWeekly } from './sinks/slack';
import type { AiVisibilityResult, SemrushSnapshot, SproutSOV } from './types';

/** Compact, number-first highlights string for the deck-design node. */
function buildHighlights(semrush: SemrushSnapshot[], ai: AiVisibilityResult[], sprout: SproutSOV): string {
  const seo = semrush
    .filter((s) => !s.error)
    .map((s) => `${s.domain} ${s.organicKeywords ?? '?'}kw/${s.organicTraffic ?? '?'} traffic`)
    .join('; ');
  const pearlAi = ai.filter((a) => a.pearlMentioned).length;
  const aiLine = `Pearl in ${pearlAi}/${ai.length} AI category answers`;
  const sovLine = sprout.available
    ? 'social SOV: ' + sprout.brands.map((b) => `${b.name} ${b.sovPct}%`).join(', ')
    : 'social SOV pending';
  return `SEO: ${seo}. ${aiLine}. ${sovLine}.`;
}

/** YYYY-MM-DD in ET, computed without Date.now arithmetic gymnastics. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function runWeekly(): Promise<void> {
  const runDate = today();
  console.log(`[competitor-intel] starting weekly run for ${runDate}`);
  const wl = loadWatchlist();

  // SOURCE NODES (parallel): Perplexity sweeps + SEMrush + AI-visibility + Sprout
  const [competitorNews, themes, newEntrants, aiVisibility, semrush, sprout] = await Promise.all([
    collectCompetitorNews(),
    collectThemes(),
    scoutNewEntrants().then((r) => r.raw),
    runAiVisibility(),
    Promise.all(wl.competitors.map((c) => snapshot(c.domain))),
    getCompetitorSOV(),
  ]);
  console.log(
    `[competitor-intel] collected: ${competitorNews.length} sweeps, ${themes.length} themes, ` +
      `${semrush.length} SEMrush, ${aiVisibility.length} AI probes, sprout=${sprout.available}`,
  );

  // CORROBORATION NODE: verify claims, weight by source quality
  const verified = await corroborate([...competitorNews, ...themes]);
  console.log(`[competitor-intel] corroborated ${verified.length} material findings`);

  // SYNTHESIS NODE (needs the Sheet first so we can pass last week's take)
  const sheetId = await ensureSheet();
  const priorTake = await readLatestTake(sheetId);
  const synthesis = await synthesize({
    runDate,
    verified,
    newEntrants,
    semrush,
    sprout,
    aiVisibility,
    priorTake,
  });
  console.log('[competitor-intel] synthesis complete');

  // PERSIST to the Sheet (system of record)
  await writeWeek(sheetId, runDate, { semrush, aiVisibility }, synthesis);

  // DECK-DESIGN NODE → render the low-text board deck
  const highlights = buildHighlights(semrush, aiVisibility, sprout);
  const specs = await designDeck(synthesis, highlights, runDate);
  const { deckUrl } = await buildDeck(specs, runDate);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;

  // DELIVERY NODE
  await postWeekly(synthesis, { deckUrl, sheetUrl }, runDate);
  console.log(`[competitor-intel] done — posted to Slack, deck: ${deckUrl}`);
}

// Allow direct execution: `node dist/competitor-intel/run.js`
if (require.main === module) {
  runWeekly()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[competitor-intel] run failed:', err);
      process.exit(1);
    });
}
