/**
 * Change detection for the daily pulse.
 *
 * - extractMaterialEvents: Claude reads the day's raw research and pulls out only
 *   MATERIAL moves (funding, M&A, product/pricing launches, major partnerships,
 *   big coverage), each with a stable dedup key and a one-line "why it matters."
 * - detectAiShifts: pure comparison of today's AI-visibility probes against the
 *   last recorded run — flags Pearl gaining/losing presence or a competitor
 *   newly appearing/dropping in cited answers.
 *
 * Alert bar (per Kat): material moves + ranking/AI-visibility shifts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ciConfig } from './config';
import type { RawResearch } from './collect';
import type { AiVisibilityResult, MaterialEvent } from './types';

const anthropic = new Anthropic({ apiKey: ciConfig.anthropicApiKey });

/** Normalize text into a stable dedup key fragment. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function extractMaterialEvents(research: RawResearch[]): Promise<MaterialEvent[]> {
  const blob = research
    .filter((r) => !/no material developments/i.test(r.text))
    .map((r) => `### ${r.subject}\n${r.text}\nSources: ${r.citations.join(', ')}`)
    .join('\n\n');
  if (!blob.trim()) return [];

  const prompt = [
    `You are Pearl's competitive-intelligence analyst. From the research below, extract ONLY`,
    `MATERIAL competitor moves worth interrupting the team for today: funding, M&A, product or`,
    `pricing launches, major partnerships, significant press, or strategy shifts. Ignore routine`,
    `social posts, minor PR, and anything not clearly dated to the last few days.`,
    `Pearl's frame: the 5 pillars (Safety, Comfort, Operations, Resilience, Energy); Pearl is the`,
    `only score covering all 5 for existing homes.`,
    ``,
    `RESEARCH:\n${blob}`,
    ``,
    `Return ONLY a JSON array (possibly empty). Each item:`,
    `{"competitor":"...","headline":"one line","category":"funding|m&a|product|pricing|partnership|coverage|other","why":"one line on why it matters to Pearl","source":"url"}`,
    `If nothing is material, return [].`,
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: ciConfig.model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    const arr = JSON.parse(text.slice(start, end + 1)) as Array<Omit<MaterialEvent, 'dedupKey'>>;
    return arr.map((e) => ({ ...e, dedupKey: `${slug(e.competitor)}:${slug(e.headline)}` }));
  } catch (err) {
    console.error('[detect] failed to parse events JSON', err);
    return [];
  }
}

/**
 * Compare today's AI-visibility probes against the last recorded run.
 * `prior` maps prompt -> last recorded brand list (in order).
 */
export function detectAiShifts(
  today: AiVisibilityResult[],
  prior: Map<string, string[]>,
): MaterialEvent[] {
  const events: MaterialEvent[] = [];
  for (const r of today) {
    const before = prior.get(r.prompt);
    if (!before) continue; // no baseline yet — nothing to compare
    const beforeSet = new Set(before);
    const nowSet = new Set(r.mentionedBrands);

    const pearlWas = beforeSet.has('Pearl');
    const pearlNow = nowSet.has('Pearl');
    if (pearlWas !== pearlNow) {
      const gained = pearlNow && !pearlWas;
      events.push({
        competitor: 'Pearl',
        headline: `Pearl ${gained ? 'now appears in' : 'dropped out of'} AI answers for "${r.prompt}"`,
        category: 'ai-visibility',
        why: gained
          ? 'Positioning win — Pearl is being cited where it previously was not.'
          : 'Positioning risk — Pearl lost a citation it previously held.',
        source: `AI probe (${r.engine})`,
        dedupKey: `ai:pearl:${gained ? 'in' : 'out'}:${slug(r.prompt)}`,
      });
    }

    // Competitor newly appearing in an answer Pearl cares about
    for (const brand of r.mentionedBrands) {
      if (brand !== 'Pearl' && !beforeSet.has(brand)) {
        events.push({
          competitor: brand,
          headline: `${brand} newly cited in AI answers for "${r.prompt}"`,
          category: 'ai-visibility',
          why: 'A competitor is gaining AI-answer share on a category question.',
          source: `AI probe (${r.engine})`,
          dedupKey: `ai:${slug(brand)}:in:${slug(r.prompt)}`,
        });
      }
    }
  }
  return events;
}
