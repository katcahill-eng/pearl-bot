/**
 * Sage v2 channel-mention intent classifier.
 *
 * Uses Anthropic Claude Haiku to map a single @Sage mention text to one
 * of five recognized intents. Kept in its own module so the heavier v3
 * claude.ts (which carries CollectedData, follow-up generation, etc.)
 * stays unchanged for now.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ChannelRole } from './division-lookup';

let _fastClient: Anthropic | null = null;
function fastClient(): Anthropic {
  if (!_fastClient) _fastClient = new Anthropic({ timeout: 15_000 });
  return _fastClient;
}

// Fast-path regex patterns. We try these first so obvious phrasings
// don't need an LLM call (and don't fail if the LLM misclassifies).
// Order matters: more-specific patterns first.
const FAST_PATHS: { pattern: RegExp; intent: V2Intent }[] = [
  { pattern: /^(is\s+this|does\s+this)\b.*\b(on[\s-]?brand|sound|read)\b/i, intent: 'light_qc' },
  { pattern: /^(qc|quality\s*check)\b/i, intent: 'light_qc' },
  { pattern: /^brand\s+(check|review)\b/i, intent: 'light_qc' },
  { pattern: /^(check|review)\s+(this|my|our)\b.*\b(brand|copy|draft|on[\s-]?brand)\b/i, intent: 'light_qc' },
  { pattern: /^(check|review)\s+(this|my|our)\s+(doc(ument)?|article|blog|email|content|link|url|copy|draft)\b/i, intent: 'light_qc' },
  { pattern: /^(check|review)\s+this\s*:/i, intent: 'light_qc' },
  { pattern: /^qc\s+this\b/i, intent: 'light_qc' },
  { pattern: /\bcheck\s+(this|it)\s+against\b/i, intent: 'light_qc' },
  { pattern: /docs\.google\.com\/document/i, intent: 'light_qc' },
  { pattern: /\bwhere'?s?\s+my\s+(request|brief|project)\b/i, intent: 'status_query' },
  { pattern: /\bwhat'?s\s+(open|in\s+flight|in\s+progress|the\s+status)\b/i, intent: 'status_query' },
  { pattern: /\b(what'?s|where\s+are)\s+(our|the)\s+(logo|tagline|brand|colors?|fonts?|guidelines?|assets?)\b/i, intent: 'info_lookup' },
  { pattern: /\b(give|send|share)\s+me\s+(the|our)\s+(logo|tagline|brand|colors?)\b/i, intent: 'info_lookup' },
  { pattern: /\b(logo|brand\s+colors?|brand\s+fonts?|brand\s+guidelines?|brand\s+assets?|brand\s+kit|style\s+guide|email\s+signature|slide\s+template|presentation\s+template)\b/i, intent: 'info_lookup' },
  { pattern: /\b(early\s+access|beta|rollout)\s+(application|program|testing|phase)s?\b/i, intent: 'work_request' },
  { pattern: /\b(application|program)\s+(for|to)\s+(early\s+access|beta|launch)\b/i, intent: 'work_request' },
  { pattern: /\b(homeowner|home\s+buyer|real\s+estate|property\s+owner)s?\b/i, intent: 'work_request' },
  { pattern: /^(i|we)\s+(need|want|would\s+like|am\s+looking\s+for)\b/i, intent: 'work_request' },
  { pattern: /^can\s+(you|marketing|someone)\s+(make|create|build|design|draft|write|put\s+together)\b/i, intent: 'work_request' },
  { pattern: /^(make|create|build|design|draft|write|put\s+together)\s+(a|an|me|us|the)\b/i, intent: 'work_request' },
  { pattern: /\b(help\s+(us|me)\s+with|support\s+(us|me)\s+with)\b/i, intent: 'work_request' },
  { pattern: /\b(position|establish|build)\s+.{0,30}(as|as\s+the)\s+(expert|leader|authority|thought\s+leader)\b/i, intent: 'work_request' },
];

export function fastPathClassify(text: string): V2Intent | null {
  for (const { pattern, intent } of FAST_PATHS) {
    if (pattern.test(text)) return intent;
  }
  return null;
}

export type V2Intent =
  | 'info_lookup'
  | 'work_request'
  | 'status_query'
  | 'light_qc'
  | 'unclear';

const SYSTEM_PROMPT = `You classify a single @-mention message to a Slack bot called Sage (Pearl marketing's intake assistant) into ONE of these intents:

- info_lookup — asking a brand or marketing-resource question (logo, tagline, brand colors, where files live)
- work_request — asking marketing to do something (new email, graphic, campaign, presentation, etc.)
- light_qc — asking whether a piece of copy is on-brand or for quick brand-compliance feedback
- status_query — asking about a request that already exists ("where's my X", "what's open in BD")
- unclear — too vague to classify confidently; the bot should ask one clarifying question

Respond with ONLY the intent string, nothing else. Examples:
"What's our logo URL?" → info_lookup
"I need a registration email for the May 12 webinar" → work_request
"Is this on-brand: Pearl is a software platform" → light_qc
"Where's my request from last week?" → status_query
"Hey" → unclear`;

const VALID_INTENTS: V2Intent[] = [
  'info_lookup',
  'work_request',
  'status_query',
  'light_qc',
  'unclear',
];

/**
 * Classify a single @Sage message text. Returns the resolved intent.
 * On classification failure, returns 'unclear' (callers handle the
 * unclear-case by asking a clarifying question).
 *
 * The role argument is informational only — the same classifier is
 * used regardless of channel role; callers downstream decide whether
 * the resolved intent is valid for that channel's role.
 */
export async function classifyChannelMention(
  text: string,
  _role: ChannelRole,
): Promise<V2Intent> {
  const cleaned = stripBotMention(text).trim();
  if (!cleaned) return 'unclear';

  // Fast-path obvious phrasings before burning a Haiku call. Also
  // a safety net against LLM misclassification of clear requests.
  const fast = fastPathClassify(cleaned);
  if (fast) return fast;

  try {
    const response = await fastClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cleaned }],
    });

    const raw = response.content[0]?.type === 'text'
      ? response.content[0].text.trim().toLowerCase()
      : '';

    const matched = VALID_INTENTS.find((i) => raw === i || raw.startsWith(i));

    if (!matched) {
      console.warn(`[v2-classifier] LLM returned unrecognized intent "${raw}" for: "${cleaned.slice(0, 80)}"`);
    }

    return matched ?? 'unclear';
  } catch (err) {
    console.error('[v2-classifier] classification failed:', err);
    return 'unclear';
  }
}

/**
 * Strip the leading <@U…> bot mention AND any common leading punctuation
 * (hyphens, em-dashes, bullets, colons) so the classifier and fast-path
 * regexes see just the user's actual message. Otherwise a message like
 * "@Sage - I need..." would fail "starts with 'I need'" matching.
 */
function stripBotMention(text: string): string {
  return text
    .replace(/^<@[A-Z0-9]+>\s*/, '')
    .replace(/^[\s\-—–•:,.]+/, '')
    .trim();
}
