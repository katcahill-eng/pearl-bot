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

const fastClient = new Anthropic({ timeout: 15_000 });

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

  try {
    const response = await fastClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cleaned }],
    });

    const raw = response.content[0]?.type === 'text'
      ? response.content[0].text.trim().toLowerCase()
      : '';

    const matched = VALID_INTENTS.find((i) => raw === i || raw.startsWith(i));
    return matched ?? 'unclear';
  } catch (err) {
    console.error('[v2-classifier] classification failed:', err);
    return 'unclear';
  }
}

/**
 * Strip the leading <@U…> bot mention from the text so the classifier
 * sees only the user's actual message.
 */
function stripBotMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/, '');
}
