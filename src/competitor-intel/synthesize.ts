/**
 * Synthesis — Claude turns the week's raw research + quantitative snapshots
 * into board-ready output: the analyst's take, what moved, threats,
 * opportunities (gaps Pearl can take), a 5-pillar narrative, and a vetted list
 * of competitors to consider adding.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ciConfig } from './config';
import { loadWatchlist } from './watchlist';
import type { RawResearch } from './collect';
import type { AiVisibilityResult, SemrushSnapshot, WeeklySynthesis } from './types';

const anthropic = new Anthropic({ apiKey: ciConfig.anthropicApiKey });

export interface SynthesisInput {
  runDate: string;
  competitorNews: RawResearch[];
  themes: RawResearch[];
  newEntrants: RawResearch;
  semrush: SemrushSnapshot[];
  aiVisibility: AiVisibilityResult[];
  priorTake?: string; // last week's analyst take, for "what changed"
}

function buildPrompt(input: SynthesisInput): string {
  const wl = loadWatchlist();
  const block = (arr: RawResearch[]) =>
    arr.map((r) => `### ${r.subject}\n${r.text}\nSources: ${r.citations.join(', ')}`).join('\n\n');

  const semrushBlock = input.semrush
    .map((s) =>
      s.error
        ? `${s.domain}: (no data — ${s.error})`
        : `${s.domain}: organic keywords ${s.organicKeywords ?? '?'}, organic traffic ${s.organicTraffic ?? '?'}, adwords keywords ${s.adwordsKeywords ?? '?'}`,
    )
    .join('\n');

  const aivBlock = input.aiVisibility
    .map(
      (a) =>
        `Q: "${a.prompt}" → brands cited (in order): ${a.mentionedBrands.join(', ') || 'none detected'}; Pearl present: ${a.pearlMentioned ? 'YES' : 'no'}`,
    )
    .join('\n');

  return [
    `You are Pearl's competitive-intelligence analyst preparing a weekly brief for the Board.`,
    `Pearl's frame: the 5 pillars — ${wl.pillars.join(', ')}. Pearl is the only standardized`,
    `score covering all 5 for existing homes; competitors typically cover 1-2. Find where`,
    `competitors are exposed and where Pearl can take ground (product, marketing, positioning).`,
    ``,
    input.priorTake ? `LAST WEEK'S TAKE (for "what changed"):\n${input.priorTake}\n` : ``,
    `=== COMPETITOR NEWS (last 7 days) ===\n${block(input.competitorNews)}`,
    ``,
    `=== STANDING THEMES ===\n${block(input.themes)}`,
    ``,
    `=== NEW-ENTRANT SCOUTING ===\n${input.newEntrants.text}\nSources: ${input.newEntrants.citations.join(', ')}`,
    ``,
    `=== SEMRUSH SNAPSHOT ===\n${semrushBlock}`,
    ``,
    `=== AI-ANSWER VISIBILITY ===\n${aivBlock}`,
    ``,
    `Return ONLY valid JSON matching this shape (no markdown, no prose outside JSON):`,
    `{`,
    `  "analystTake": "one tight paragraph — the single most important thing for the board this week",`,
    `  "movements": ["concrete things that changed this week, each with the competitor named"],`,
    `  "threats": ["escalations or risks, prioritized"],`,
    `  "opportunities": ["specific gaps Pearl can take ground in — product, marketing, or positioning"],`,
    `  "pillarNotes": "short narrative on how the week maps to the 5-pillar story",`,
    `  "suggestedAdditions": [{"name": "...", "category": "...", "reason": "...", "source": "..."}]`,
    `}`,
    `Be specific and sourced. Omit filler. If a section has nothing real, use an empty array or "No material change."`,
  ].join('\n');
}

export async function synthesize(input: SynthesisInput): Promise<WeeklySynthesis> {
  const msg = await anthropic.messages.create({
    model: ciConfig.model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: buildPrompt(input) }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseSynthesis(text);
}

/** Defensive JSON parse — strips code fences and falls back to a safe shell. */
function parseSynthesis(text: string): WeeklySynthesis {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const json = JSON.parse(cleaned.slice(start, end + 1));
    return {
      analystTake: json.analystTake ?? '',
      movements: json.movements ?? [],
      threats: json.threats ?? [],
      opportunities: json.opportunities ?? [],
      pillarNotes: json.pillarNotes ?? '',
      suggestedAdditions: json.suggestedAdditions ?? [],
    };
  } catch (err) {
    console.error('[synthesize] failed to parse JSON, returning raw take', err);
    return {
      analystTake: cleaned.slice(0, 1500),
      movements: [],
      threats: [],
      opportunities: [],
      pillarNotes: '',
      suggestedAdditions: [],
    };
  }
}
