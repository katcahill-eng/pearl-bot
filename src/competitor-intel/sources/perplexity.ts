/**
 * Perplexity research client.
 *
 * Phase 1 research engine: weekly news/funding/M&A/product/pricing sweeps per
 * competitor, plus market scouting for new entrants. Perplexity searches the
 * live web and returns citations, which we keep as sources.
 *
 * Docs: POST https://api.perplexity.ai/chat/completions (OpenAI-compatible).
 */

import { ciConfig } from '../config';

const ENDPOINT = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar-pro'; // web-grounded; returns citations

interface PerplexityResponse {
  choices: Array<{ message: { content: string } }>;
  citations?: string[];
  search_results?: Array<{ url: string; title?: string }>;
}

export interface PerplexityAnswer {
  text: string;
  citations: string[];
}

/**
 * Ask Perplexity a research question. `recencyDays` biases toward fresh results
 * (we want the last week for the weekly sweep).
 */
export async function ask(
  prompt: string,
  opts: { recencyDays?: number; system?: string } = {},
): Promise<PerplexityAnswer> {
  const messages = [
    {
      role: 'system',
      content:
        opts.system ??
        'You are a competitive-intelligence analyst. Be concise, factual, and ' +
          'date-stamped. Only report developments you can source. If nothing ' +
          'material is found, say so explicitly.',
    },
    { role: 'user', content: prompt },
  ];

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: 0.2,
  };
  // Perplexity recency filter: 'week' | 'month' | 'day'
  if (opts.recencyDays && opts.recencyDays <= 7) body.search_recency_filter = 'week';
  else if (opts.recencyDays && opts.recencyDays <= 31) body.search_recency_filter = 'month';

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ciConfig.perplexityApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[perplexity] ${res.status} ${res.statusText}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as PerplexityResponse;
  const text = data.choices?.[0]?.message?.content ?? '';
  const citations =
    data.citations ?? data.search_results?.map((r) => r.url).filter(Boolean) ?? [];
  return { text, citations };
}
