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
import { synthesize } from './synthesize';
import { ensureSheet, writeWeek, readLatestTake } from './sinks/sheet';
import { buildDeck } from './sinks/slides';
import { postWeekly } from './sinks/slack';

/** YYYY-MM-DD in ET, computed without Date.now arithmetic gymnastics. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function runWeekly(): Promise<void> {
  const runDate = today();
  console.log(`[competitor-intel] starting weekly run for ${runDate}`);
  const wl = loadWatchlist();

  // 1 + 2: collect qualitative + quantitative in parallel
  const [competitorNews, themes, newEntrants, aiVisibility, semrush] = await Promise.all([
    collectCompetitorNews(),
    collectThemes(),
    scoutNewEntrants().then((r) => r.raw),
    runAiVisibility(),
    Promise.all(wl.competitors.map((c) => snapshot(c.domain))),
  ]);
  console.log(
    `[competitor-intel] collected: ${competitorNews.length} competitor sweeps, ` +
      `${themes.length} themes, ${semrush.length} SEMrush, ${aiVisibility.length} AI probes`,
  );

  // 3: synthesize (needs the Sheet first so we can pass last week's take)
  const sheetId = await ensureSheet();
  const priorTake = await readLatestTake(sheetId);
  const synthesis = await synthesize({
    runDate,
    competitorNews,
    themes,
    newEntrants,
    semrush,
    aiVisibility,
    priorTake,
  });
  console.log('[competitor-intel] synthesis complete');

  // 4: persist
  await writeWeek(sheetId, runDate, { semrush, aiVisibility }, synthesis);

  // 5: render deck
  const { deckUrl } = await buildDeck(synthesis, aiVisibility, runDate);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;

  // 6: deliver
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
