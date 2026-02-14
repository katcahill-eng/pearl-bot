import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
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
  project_keywords: string[] | null;
  confidence: number;
  acknowledgment: string | null;
}

export type RequestClassification = 'quick' | 'full' | 'undetermined';

export interface FollowUpQuestion {
  id: string;
  question: string;
  field_key: string;
}

// --- Client ---

const client = new Anthropic({
  timeout: 30_000, // 30s timeout — prevents silent hangs from stalling the bot
});

// --- Knowledge Base ---

const KNOWLEDGE_BASE = fs.readFileSync(
  path.join(__dirname, 'knowledge-base.md'),
  'utf-8',
);

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
- project_keywords: An array of short phrases (1-3 words each) from the user's message that could be names of or keywords for existing marketing projects or campaigns. Only include distinctive phrases, not generic words like "marketing" or "support". Examples: ["early access"], ["Q2 newsletter", "partner program"], ["AHR Expo"]

Additional field:
- acknowledgment: A brief, natural one-sentence confirmation of what you extracted. This will be shown to the user as a conversational reply. Write it as if you're a friendly coworker confirming what they said.
  Examples:
  - "Got it — you have a webinar series coming up and need marketing support." (if context_background was extracted)
  - "Thanks, Kat!" (if only requester_name was extracted)
  - "Noted — you need a one-pager and 3 social posts." (if deliverables were extracted)
  - "Got it — targeting real estate agents in the Southeast." (if target was extracted)
  Keep it short (one sentence), natural, and accurate to what the user actually said.

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
  currentStep?: string | null,
): Promise<ExtractedFields> {
  const today = currentDate ?? new Date().toISOString().split('T')[0];

  const userPrompt = buildUserPrompt(message, conversationState, today, currentStep);

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

  // Check if any deliverable matches a quick asset type
  const quickDeliverableKeywords = [
    'social post', 'social media post', 'one-pager', 'one pager',
    'email template', 'blog post', 'flyer', 'banner', 'graphic',
    'icon', 'headshot', 'photo edit', 'update', 'revision', 'tweak', 'edit',
  ];
  const hasQuickDeliverable = deliverables.some((d) =>
    quickDeliverableKeywords.some((kw) => d.toLowerCase().includes(kw)),
  );

  // Classification logic — deliverable count + type takes priority over context keywords
  // 1. 1-2 deliverables that match quick asset types → quick
  if (deliverables.length >= 1 && deliverables.length <= 2 && hasQuickDeliverable) return 'quick';
  // 2. 3+ deliverables → full
  if (deliverables.length > 2) return 'full';
  // 3. 1 deliverable (any type) → quick
  if (deliverables.length === 1) return 'quick';
  // 4. Full keyword + 2 deliverables → full
  if (isFullKeyword && deliverables.length === 2) return 'full';
  // 5. 2 deliverables (no signal) → full
  if (deliverables.length === 2) return 'full';
  // 6. Full keyword + 0 deliverables → full
  if (isFullKeyword && deliverables.length === 0) return 'full';
  // 7. Quick keyword anywhere + 0 deliverables → quick
  if (isQuickKeyword && deliverables.length === 0) return 'quick';
  // 8. Fallback
  return 'undetermined';
}

// --- Helpers ---

function buildUserPrompt(
  message: string,
  conversationState: Partial<CollectedData>,
  today: string,
  currentStep?: string | null,
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

  if (currentStep) {
    parts.push(`The bot just asked the user about: ${currentStep}. Prioritize mapping their response to this field unless it clearly belongs elsewhere.`);
    parts.push('');
  }

  parts.push(`User message: "${message}"`);

  return parts.join('\n');
}

// --- Follow-up functions ---

/**
 * Classify the type of marketing request based on collected data.
 * Returns an array of types — a request can span multiple types (e.g., conference + webinar).
 */
export async function classifyRequestType(
  collectedData: Partial<CollectedData>,
): Promise<string[]> {
  const systemPrompt = `You classify marketing requests into one or more of these types based on the information provided:
- conference
- insider_dinner
- webinar
- email
- graphic_design
- general

Look at the context_background, deliverables, target audience, and desired_outcomes to determine the best fit.
A request can span multiple types — for example, a conference that also includes a webinar should return "conference,webinar".

If it doesn't clearly match a specific type, return "general".

Respond with ONLY the type string(s), comma-separated if multiple, nothing else. Examples: "conference", "conference,webinar", "email", "general"`;

  const userPrompt = `Classify this marketing request:
- Context/Background: ${collectedData.context_background ?? 'Not provided'}
- Deliverables: ${(collectedData.deliverables ?? []).join(', ') || 'Not provided'}
- Target: ${collectedData.target ?? 'Not provided'}
- Desired Outcomes: ${collectedData.desired_outcomes ?? 'Not provided'}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 50,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim().toLowerCase() : 'general';
  const validTypes = ['conference', 'insider_dinner', 'webinar', 'email', 'graphic_design', 'general'];
  const types = text.split(',').map((t) => t.trim()).filter((t) => validTypes.includes(t));
  return types.length > 0 ? types : ['general'];
}

/**
 * Generate follow-up questions tailored to the request type(s) using the knowledge base.
 */
export async function generateFollowUpQuestions(
  collectedData: Partial<CollectedData>,
  requestTypes: string[],
): Promise<FollowUpQuestion[]> {
  const typesLabel = requestTypes.join(' + ');
  const systemPrompt = `You are MarcomsBot, a Slack intake assistant for Pearl's marketing team.

Using the knowledge base below, generate follow-up questions for a "${typesLabel}" marketing request.
${requestTypes.length > 1 ? `\nThis request spans multiple types (${typesLabel}). Generate questions that cover ALL applicable types — for example, conference logistics AND webinar format if both apply.` : ''}

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}

Rules:
- Generate 3-7 conversational, friendly questions appropriate for this request type
- Skip anything already answered in the collected data provided
- If the user already provided information in their collected data that answers a potential question, do NOT generate that question
- Include expectation-setting context naturally within questions (e.g., "Just so you know, printed materials are charged back to your department — do you need anything printed?")
- Each question should feel conversational, not like a form field
- Return a JSON array of objects with: id (string, unique), question (string), field_key (string, snake_case key for storing the answer)

Respond with ONLY a JSON array, no markdown formatting, no code blocks.`;

  const collected = Object.entries(collectedData)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');

  const userPrompt = `Already collected:\n${collected || 'Nothing yet'}\n\nGenerate follow-up questions for this ${typesLabel} request.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]';

  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as FollowUpQuestion[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.error('[claude] Failed to parse follow-up questions:', text);
    return [];
  }
}

/**
 * Interpret a user's free-text answer to a specific follow-up question.
 * Can extract multiple fields if the user answers ahead.
 */
export async function interpretFollowUpAnswer(
  message: string,
  question: FollowUpQuestion,
  collectedData: Partial<CollectedData>,
  upcomingQuestions?: FollowUpQuestion[],
): Promise<{ value: string; additional_fields?: Record<string, string> }> {
  const upcomingList = upcomingQuestions && upcomingQuestions.length > 0
    ? `\n\nUpcoming questions the user hasn't been asked yet:\n${upcomingQuestions.map((q) => `- field_key: "${q.field_key}" — "${q.question}"`).join('\n')}\n\nIf the user's answer also addresses any of these upcoming questions, include them in additional_fields using their field_key.`
    : '';

  const systemPrompt = `You are interpreting a user's answer to a follow-up question in a marketing intake conversation.

The question asked was: "${question.question}"
The field key for this answer is: "${question.field_key}"

Extract the answer to the asked question. If the user also provides information that answers other potential follow-up questions, extract those too.${upcomingList}

Return a JSON object with:
- "value": the answer to the current question (string)
- "additional_fields": optional object mapping field_key → value for any extra info provided

If the user's message doesn't answer the question (off-topic, unclear), set value to an empty string.

Respond with ONLY a JSON object, no markdown formatting, no code blocks.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: `User's answer: "${message}"` }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned) as { value: string; additional_fields?: Record<string, string> };
    return {
      value: parsed.value ?? '',
      additional_fields: parsed.additional_fields,
    };
  } catch {
    // Fallback: use the raw message as the value
    return { value: message };
  }
}

// --- Helpers ---

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
      project_keywords: parsed.project_keywords ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      acknowledgment: parsed.acknowledgment ?? null,
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
      project_keywords: null,
      confidence: 0,
      acknowledgment: null,
    };
  }
}
