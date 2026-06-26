/**
 * Deck-design node.
 *
 * Turns the synthesis + key numbers into a deliberately LOW-TEXT slide spec:
 * each slide is a sharp title, at most 3 short bullets, and one highlighted
 * callout (a number or the single takeaway). This is the fix for the
 * text-heavy v1 deck — brevity is enforced at the spec layer, before rendering.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ciConfig } from '../config';
import type { SlideSpec, WeeklySynthesis } from '../types';

const anthropic = new Anthropic({ apiKey: ciConfig.anthropicApiKey });

export async function designDeck(
  synthesis: WeeklySynthesis,
  dataHighlights: string,
  runDate: string,
): Promise<SlideSpec[]> {
  const prompt = [
    `You are a board-deck designer. Turn the competitive briefing below into a clean, LOW-TEXT`,
    `slide spec for Pearl's board. Hard rules:`,
    `- 6 to 8 slides.`,
    `- Each slide: a sharp title, AT MOST 3 bullets, each bullet <= 12 words (fragments, not sentences).`,
    `- Each slide has ONE "callout": a single number, stat, or one-line takeaway that anchors the slide.`,
    `- Slide 1 is the title slide (title = "Competitor Intelligence — week of ${runDate}", callout = the single most important takeaway, no bullets).`,
    `- Prefer concrete numbers (from the data highlights) over adjectives. No filler.`,
    ``,
    `ANALYST TAKE: ${synthesis.analystTake}`,
    `MOVEMENTS: ${synthesis.movements.join(' | ')}`,
    `THREATS: ${synthesis.threats.join(' | ')}`,
    `OPPORTUNITIES: ${synthesis.opportunities.join(' | ')}`,
    `5-PILLAR READ: ${synthesis.pillarNotes}`,
    `SUGGESTED ADDITIONS: ${synthesis.suggestedAdditions.map((s) => s.name).join(', ')}`,
    `DATA HIGHLIGHTS (use these numbers): ${dataHighlights}`,
    ``,
    `Return ONLY a JSON array of slides: [{"title":"...","bullets":["..."],"callout":"..."}]`,
  ].join('\n');

  const msg = await anthropic.messages.create({
    model: ciConfig.model,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  try {
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as SlideSpec[];
    // Enforce the low-text contract even if the model overruns.
    return arr.map((s) => ({
      title: s.title ?? '',
      bullets: (s.bullets ?? []).slice(0, 3).map((b) => String(b)),
      callout: s.callout ? String(s.callout) : undefined,
    }));
  } catch (err) {
    console.error('[deck-design] failed to parse slide spec; falling back to minimal deck', err);
    return [
      { title: `Competitor Intelligence — week of ${runDate}`, bullets: [], callout: synthesis.analystTake.slice(0, 140) },
      { title: 'What moved', bullets: synthesis.movements.slice(0, 3), callout: undefined },
      { title: 'Where Pearl can take ground', bullets: synthesis.opportunities.slice(0, 3), callout: undefined },
    ];
  }
}
