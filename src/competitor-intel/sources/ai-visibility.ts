/**
 * AI-answer visibility ("share of voice in AI answers").
 *
 * We measure the thing Profound sells — who AI engines cite for category
 * questions — by directly asking the engines and parsing which brands appear.
 * Phase 1 uses Perplexity (web-grounded, returns citations). Phase 2 adds
 * Gemini and an OpenAI/ChatGPT engine for multi-engine share of voice.
 */

import { ask } from './perplexity';
import { loadWatchlist } from '../watchlist';
import type { AiVisibilityResult } from '../types';

/** Detect which tracked brands (plus Pearl) appear in an answer, in order. */
function detectBrands(text: string, brandNames: string[]): string[] {
  const lower = text.toLowerCase();
  const hits: Array<{ name: string; idx: number }> = [];
  for (const name of brandNames) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) hits.push({ name, idx });
  }
  return hits.sort((a, b) => a.idx - b.idx).map((h) => h.name);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Run all watchlist AI-visibility probe prompts through Perplexity. */
export async function runAiVisibility(): Promise<AiVisibilityResult[]> {
  const wl = loadWatchlist();
  const brandNames = ['Pearl', ...wl.competitors.map((c) => c.name)];
  const results: AiVisibilityResult[] = [];

  for (const prompt of wl.ai_visibility_prompts) {
    try {
      const ans = await ask(prompt, { recencyDays: 31 });
      const mentioned = detectBrands(ans.text, brandNames);
      results.push({
        prompt,
        engine: 'perplexity',
        mentionedBrands: mentioned,
        pearlMentioned: mentioned.includes('Pearl'),
        citationDomains: [...new Set(ans.citations.map(domainOf))],
      });
    } catch (err) {
      // Skip a failed probe rather than failing the whole run.
      console.error(`[ai-visibility] probe failed: ${prompt}`, err);
    }
  }
  return results;
}
