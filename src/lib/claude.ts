import Anthropic from '@anthropic-ai/sdk';
import type { CollectedData } from './conversation';

// --- Types ---

export interface ExtractedFields {
  requester_name: string | null;
  requester_department: string | null;
  target: string | null;
  context_background: string | null;
  desired_outcomes: string | null;
  deliverables: string[] | null;
  due_date: string | null;
  due_date_parsed: string | null;
  approvals: string | null;
  constraints: string | null;
  supporting_links: string[] | null;
  confidence: number;
}

export type RequestClassification = 'quick' | 'full' | 'undetermined';

// --- Client ---

const client = new Anthropic();

// --- System prompt ---

const SYSTEM_PROMPT = `You are MarcomsBot, a Slack intake assistant for the Pearl marketing team.
Your job is to extract structured information from a user's free-text message about a marketing request.

Pearl is a home performance company. Its divisions include: CX, Corporate, BD (Business Development), Product, P2 (Pearl Partner Program), Marketing, and Other. When a user says their department, map it to the closest match from this list. Use the exact division name from this list (e.g., "CX" not "Customer Experience", "BD" not "Business Development", "P2" not "Pearl Partner Program"). If none match, use "Other".

Extract any of the following fields from the user's message. Return ONLY the fields you can confidently extract — do not guess or fabricate.

Fields:
- requester_name: The name of the person making the request (if mentioned or if they introduce themselves)
- requester_department: The Pearl department/team making the request — must be one of: "CX", "Corporate", "BD", "Product", "P2", "Marketing", or "Other"
- target: The target audience for this request (e.g., "homeowners", "real estate agents", "conference attendees", "internal team")
- context_background: Context and background explaining why this request exists and what prompted it
- desired_outcomes: What the requester hopes to achieve (e.g., "increase sign-ups by 20%", "generate leads", "drive awareness")
- deliverables: An array of specific deliverables needed (e.g., ["1 one-pager PDF", "3 social posts"])
- due_date: The due date as the user expressed it (e.g., "next Friday", "February 15", "end of month", "ASAP")
- due_date_parsed: Your best ISO date interpretation (YYYY-MM-DD) of the due date. For relative dates like "next Friday" or "end of month", calculate from today's date which will be provided. If the user says "ASAP", set this to null.
- approvals: Any specific approval requirements (e.g., "VP of Sales sign-off", "Legal review required")
- constraints: Any constraints or limitations (e.g., "must follow new brand guidelines", "budget cap of $5K")
- supporting_links: An array of any URLs or links the user mentions (e.g., ["https://docs.google.com/...", "https://competitor.com/page"])

Rules:
- Handle bundled responses: if a user provides multiple fields in one message, extract ALL of them
- For department detection, handle natural language: "I'm on the customer experience team" → "CX", "business development" → "BD", "partner program" → "P2", "corporate team" → "Corporate"
- For dates: "Friday" → next Friday, "end of month" → last day of current month, "in two weeks" → 14 days from today
- If the user says "ASAP" or "urgent", set due_date to "ASAP"
- If a user says "skip", "none", "n/a", or "no" for optional fields (approvals, constraints, supporting_links), return null for that field — do not store the skip keyword
- If you cannot extract a field, omit it or set it to null
- The confidence field (0-1) indicates your overall confidence in the extraction

Respond with ONLY a JSON object, no markdown formatting, no code blocks, no explanation.`;

// --- Public API ---

/**
 * Send a user message to Claude for structured field extraction.
 * Passes the current conversation state so Claude knows what has already been collected.
 */
export async function interpretMessage(
  message: string,
  conversationState: Partial<CollectedData>,
  currentDate?: string,
): Promise<ExtractedFields> {
  const today = currentDate ?? new Date().toISOString().split('T')[0];

  const userPrompt = buildUserPrompt(message, conversationState, today);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';

  return parseExtractedFields(text);
}

/**
 * Classify a request as 'quick', 'full', or 'undetermined' based on collected data.
 * - quick: single deliverable, straightforward asset types
 * - full: multiple deliverables, complex project types, or campaign-level work
 */
export function classifyRequest(
  collectedData: Partial<CollectedData>,
): RequestClassification {
  const deliverables = collectedData.deliverables ?? [];
  const context = (collectedData.context_background ?? '').toLowerCase();
  const outcomes = (collectedData.desired_outcomes ?? '').toLowerCase();

  // Complex project keywords → full
  const fullKeywords = [
    'campaign',
    'launch',
    'rebrand',
    'overhaul',
    'strategy',
    'multi-channel',
    'multichannel',
    'series',
    'event',
    'conference',
    'trade show',
    'program',
    'initiative',
  ];

  const isFullKeyword = fullKeywords.some(
    (kw) => context.includes(kw) || outcomes.includes(kw),
  );

  // Simple asset keywords → quick
  const quickKeywords = [
    'social post',
    'social media post',
    'one-pager',
    'one pager',
    'email template',
    'blog post',
    'flyer',
    'banner',
    'graphic',
    'icon',
    'headshot',
    'photo edit',
    'update',
    'revision',
    'tweak',
    'edit',
  ];

  const isQuickKeyword = quickKeywords.some(
    (kw) => context.includes(kw) || outcomes.includes(kw),
  );

  // Classification logic
  if (isFullKeyword) return 'full';
  if (deliverables.length > 2) return 'full';
  if (deliverables.length <= 1 && isQuickKeyword) return 'quick';
  if (deliverables.length === 1) return 'quick';
  if (deliverables.length === 2 && isQuickKeyword) return 'quick';
  if (deliverables.length === 2) return 'full';

  return 'undetermined';
}

// --- Helpers ---

function buildUserPrompt(
  message: string,
  conversationState: Partial<CollectedData>,
  today: string,
): string {
  const parts: string[] = [`Today's date: ${today}`, ''];

  // Show what has already been collected so Claude knows context
  const collected = Object.entries(conversationState).filter(
    ([, v]) =>
      v !== null &&
      v !== undefined &&
      v !== '' &&
      !(Array.isArray(v) && v.length === 0),
  );

  if (collected.length > 0) {
    parts.push('Already collected from this conversation:');
    for (const [key, val] of collected) {
      parts.push(`- ${key}: ${Array.isArray(val) ? val.join(', ') : val}`);
    }
    parts.push('');
  }

  parts.push(`User message: "${message}"`);

  return parts.join('\n');
}

function parseExtractedFields(text: string): ExtractedFields {
  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Partial<ExtractedFields>;

    return {
      requester_name: parsed.requester_name ?? null,
      requester_department: parsed.requester_department ?? null,
      target: parsed.target ?? null,
      context_background: parsed.context_background ?? null,
      desired_outcomes: parsed.desired_outcomes ?? null,
      deliverables: parsed.deliverables ?? null,
      due_date: parsed.due_date ?? null,
      due_date_parsed: parsed.due_date_parsed ?? null,
      approvals: parsed.approvals ?? null,
      constraints: parsed.constraints ?? null,
      supporting_links: parsed.supporting_links ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch {
    // If Claude returns unparseable text, return empty with zero confidence
    return {
      requester_name: null,
      requester_department: null,
      target: null,
      context_background: null,
      desired_outcomes: null,
      deliverables: null,
      due_date: null,
      due_date_parsed: null,
      approvals: null,
      constraints: null,
      supporting_links: null,
      confidence: 0,
    };
  }
}
