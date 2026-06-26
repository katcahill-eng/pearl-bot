/**
 * Corroboration node.
 *
 * Takes the week's raw research and returns only MATERIAL findings, each with a
 * confidence label derived from source quality + independence:
 *   - confirmed   : 2+ independent and/or authoritative sources (press, filings)
 *   - reported    : a single credible source
 *   - unverified  : only a competitor's own social post, or one weak source
 *
 * This is the fix for the "Kukun's $14M raise was only on their own Instagram"
 * problem — such claims now surface as `unverified` rather than as fact.
 * Synthesis downstream is told to weight by confidence.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ciConfig } from '../config';
import type { RawResearch } from '../collect';
import type { VerifiedFinding } from '../types';

const anthropic = new Anthropic({ apiKey: ciConfig.anthropicApiKey });

export async function corroborate(research: RawResearch[]): Promise<VerifiedFinding[]> {
  const blob = research
    .filter((r) => !/no material developments/i.test(r.text))
    .map((r) => `### ${r.subject}\n${r.text}\nSOURCES: ${r.citations.join(', ')}`)
    .join('\n\n');
  if (!blob.trim()) return [];

  const prompt = [
    `You are Pearl's competitive-intelligence fact-checker. From the research below, extract`,
    `MATERIAL competitor developments (funding, M&A, product/pricing launches, major`,
    `partnerships, significant press, strategy shifts). For EACH, judge how well-sourced it is.`,
    ``,
    `Source-quality rules:`,
    `- "confirmed": backed by 2+ independent sources, OR a clearly authoritative one (established`,
    `  press like Inman/HousingWire/Reuters, an SEC/legal filing, or the company's official newsroom).`,
    `- "reported": a single credible third-party source.`,
    `- "unverified": ONLY the competitor's own social post (Instagram/LinkedIn/Facebook/X), a single`,
    `  blog/forum post, or otherwise weak/uncorroborated. Be strict: a company's own Instagram`,
    `  announcing its funding is "unverified" until independent coverage exists.`,
    ``,
    `RESEARCH:\n${blob}`,
    ``,
    `Return ONLY a JSON array (possibly empty). Each item:`,
    `{"competitor":"...","headline":"one line","detail":"one or two sentences","category":"funding|m&a|product|pricing|partnership|coverage|strategy|other","confidence":"confirmed|reported|unverified","sourceCount":<int>,"bestSourceType":"press|company newsroom|filing|company social|blog|other","sources":["url", ...]}`,
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: ciConfig.model,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as VerifiedFinding[];
    return arr.map((f) => ({
      competitor: f.competitor ?? 'unknown',
      headline: f.headline ?? '',
      detail: f.detail ?? '',
      category: f.category ?? 'other',
      confidence: (['confirmed', 'reported', 'unverified'].includes(f.confidence) ? f.confidence : 'unverified') as VerifiedFinding['confidence'],
      sourceCount: Number(f.sourceCount) || (f.sources?.length ?? 0),
      bestSourceType: f.bestSourceType ?? 'other',
      sources: f.sources ?? [],
    }));
  } catch (err) {
    console.error('[corroborate] failed to parse JSON', err);
    return [];
  }
}
