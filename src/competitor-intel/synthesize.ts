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
import type {
  AiVisibilityResult,
  SemrushSnapshot,
  SproutSOV,
  VerifiedFinding,
  WeeklySynthesis,
} from './types';

const anthropic = new Anthropic({ apiKey: ciConfig.anthropicApiKey });

export interface SynthesisInput {
  runDate: string;
  verified: VerifiedFinding[]; // from the corroboration node
  newEntrants: RawResearch;
  semrush: SemrushSnapshot[];
  sprout: SproutSOV;
  aiVisibility: AiVisibilityResult[];
  priorTake?: string; // last week's analyst take, for "what changed"
}

function buildPrompt(input: SynthesisInput): string {
  const wl = loadWatchlist();

  const verifiedBlock = input.verified.length
    ? input.verified
        .map(
          (f) =>
            `[${f.confidence.toUpperCase()}] ${f.competitor} — ${f.headline} (${f.detail}) ` +
            `[${f.sourceCount} src, best: ${f.bestSourceType}]`,
        )
        .join('\n')
    : 'No material developments this period.';

  const semrushBlock = input.semrush
    .map((s) => {
      if (s.error) return `${s.domain}: (no data — ${s.error})`;
      const topAd = s.adCopies?.[0]?.title ? ` | sample ad: "${s.adCopies[0].title}"` : '';
      return `${s.domain}: organic kw ${s.organicKeywords ?? '?'}, organic traffic ${s.organicTraffic ?? '?'}, paid/adwords kw ${s.adwordsKeywords ?? '?'}${topAd}`;
    })
    .join('\n');

  const sproutBlock = input.sprout.available
    ? input.sprout.brands
        .map((b) => `${b.name}: ${b.sovPct}% SOV (${b.volume} mentions)` + (b.sentimentNegative != null ? `, neg ${b.sentimentNegative}` : ''))
        .join('\n')
    : `(social share-of-voice unavailable: ${input.sprout.note ?? 'pending'})`;

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
    `IMPORTANT — weight findings by confidence. Lead with CONFIRMED items. Treat REPORTED items`,
    `as likely. For UNVERIFIED items (e.g. a competitor's own social post), hedge explicitly`,
    `("reportedly", "per their own channel, unconfirmed") — never state them as established fact.`,
    ``,
    input.priorTake ? `LAST WEEK'S TAKE (for "what changed"):\n${input.priorTake}\n` : ``,
    `=== VERIFIED FINDINGS (with confidence) ===\n${verifiedBlock}`,
    ``,
    `=== NEW-ENTRANT SCOUTING ===\n${input.newEntrants.text}\nSources: ${input.newEntrants.citations.join(', ')}`,
    ``,
    `=== SEMRUSH SNAPSHOT (search + paid ads) ===\n${semrushBlock}`,
    ``,
    `=== SOCIAL SHARE OF VOICE (Sprout Listening) ===\n${sproutBlock}`,
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
