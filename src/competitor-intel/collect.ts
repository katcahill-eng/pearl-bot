/**
 * Weekly collection pass — runs the Perplexity research sweeps.
 *
 * Produces raw, cited research blobs (per competitor, per standing thread, plus
 * new-entrant scouting). Claude turns these into structured board output in
 * synthesize.ts. SEMrush + AI-visibility are collected separately in run.ts.
 */

import { ask } from './sources/perplexity';
import { loadWatchlist } from './watchlist';
import type { ProposedCompetitor } from './types';

export interface RawResearch {
  subject: string;
  text: string;
  citations: string[];
}

/** Per-competitor: what moved in the last week. */
export async function collectCompetitorNews(): Promise<RawResearch[]> {
  const wl = loadWatchlist();
  const out: RawResearch[] = [];
  for (const c of wl.competitors) {
    const prompt =
      `Report only developments from the last 7 days about ${c.name} (${c.domain}), ` +
      `a company in the ${c.category} space. Cover: product launches, pricing changes, ` +
      `funding, M&A, major partnerships, executive/strategy shifts, and press coverage. ` +
      `For each item give a one-line headline, the date, and the source. ` +
      `If nothing material happened this week, reply exactly: "No material developments."`;
    try {
      const ans = await ask(prompt, { recencyDays: 7 });
      out.push({ subject: c.name, text: ans.text, citations: ans.citations });
    } catch (err) {
      console.error(`[collect] ${c.name} sweep failed`, err);
    }
  }
  return out;
}

/** Standing themes (consolidation, funding in category, climate-data moves, etc.). */
export async function collectThemes(): Promise<RawResearch[]> {
  const wl = loadWatchlist();
  const out: RawResearch[] = [];
  for (const theme of wl.standing_threads) {
    const prompt =
      `In the residential real estate / home-data / home-scoring / climate-risk / ` +
      `home-energy space, report developments from the last 7 days relevant to this theme: ` +
      `"${theme}". Give dated, sourced one-liners. If nothing this week, reply "No material developments."`;
    try {
      const ans = await ask(prompt, { recencyDays: 7 });
      out.push({ subject: theme, text: ans.text, citations: ans.citations });
    } catch (err) {
      console.error(`[collect] theme sweep failed: ${theme}`, err);
    }
  }
  return out;
}

/**
 * Scout for new entrants Pearl isn't tracking yet. Returns lightly-parsed
 * candidates; Claude refines/dedupes them in synthesize.ts. Final list goes
 * into the Sheet's "Suggested to add" section for Kat's approval.
 */
export async function scoutNewEntrants(): Promise<{ raw: RawResearch; candidates: ProposedCompetitor[] }> {
  const wl = loadWatchlist();
  const known = wl.competitors.map((c) => c.name).join(', ');
  const prompt =
    `We track these competitors in the home-scoring / home-condition / home-energy / ` +
    `climate-risk / real-estate-data space: ${known}. ` +
    `Identify up to 5 OTHER companies, startups, or products active in these spaces that ` +
    `we are NOT already tracking and that could compete with a whole-home score covering ` +
    `safety, comfort, operations, resilience, and energy. For each: name, one-line on what ` +
    `they do, and why they're worth watching. Prefer recently funded or recently launched players.`;
  const ans = await ask(prompt, { recencyDays: 90 });
  // Light parse: Claude will do the authoritative extraction in synthesize.
  return { raw: { subject: 'new-entrants', text: ans.text, citations: ans.citations }, candidates: [] };
}
