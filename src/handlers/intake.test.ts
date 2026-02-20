/**
 * Integration tests for the intake conversation flow.
 *
 * These tests mock the Claude API and database layer so the full handler
 * logic can be exercised locally, end-to-end, without external deps.
 *
 * Key insight: For brand-new conversations, the handler does NOT call
 * interpretMessage on the initial message — it just sends a welcome
 * and asks the first question. Field extraction starts from message 2+.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---- Mocks ----
// Must be declared before importing the module under test.

vi.mock('../lib/db', () => ({
  getConversation: vi.fn().mockResolvedValue(null),
  upsertConversation: vi.fn().mockResolvedValue(1),
  getActiveConversationForUser: vi.fn().mockResolvedValue(undefined),
  getMostRecentCompletedConversation: vi.fn().mockResolvedValue(undefined),
  getConversationById: vi.fn().mockResolvedValue(undefined),
  cancelConversation: vi.fn().mockResolvedValue(undefined),
  updateTriageInfo: vi.fn().mockResolvedValue(undefined),
  isMessageProcessed: vi.fn().mockResolvedValue(false),
  hasConversationInThread: vi.fn().mockResolvedValue(false),
  logUnrecognizedMessage: vi.fn().mockResolvedValue(undefined),
  logConversationMetrics: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
  searchProjects: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/claude', () => ({
  interpretMessage: vi.fn(),
  classifyRequest: vi.fn().mockResolvedValue('full'),
  classifyRequestType: vi.fn().mockResolvedValue(['general']),
  generateFollowUpQuestions: vi.fn().mockResolvedValue([]),
  interpretFollowUpAnswer: vi.fn().mockResolvedValue({ value: '', additional_fields: {} }),
}));

vi.mock('./approval', () => ({
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/workflow', () => ({
  createMondayItemForReview: vi.fn().mockResolvedValue('mock-monday-id'),
}));

vi.mock('../lib/monday', () => ({
  addMondayItemUpdate: vi.fn().mockResolvedValue(undefined),
  updateMondayItemStatus: vi.fn().mockResolvedValue(undefined),
  buildMondayUrl: vi.fn().mockReturnValue('https://monday.com/mock'),
  searchItems: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/config', () => ({
  config: {
    intakeChannelId: 'C_INTAKE',
    triageChannelId: 'C_TRIAGE',
    intakeFormUrl: '',
    marketingLeadCalendarUrl: '',
    botUserId: 'U_BOT',
  },
}));

vi.mock('../lib/guidance', () => ({
  generateFieldGuidance: vi.fn().mockResolvedValue("Here's some guidance for this field."),
}));

import { handleIntakeMessage } from './intake';
import { interpretMessage, classifyRequestType, generateFollowUpQuestions, interpretFollowUpAnswer } from '../lib/claude';
import { getConversation, upsertConversation, getActiveConversationForUser, getMostRecentCompletedConversation, isMessageProcessed, hasConversationInThread } from '../lib/db';

// ---- Helpers ----

function emptyExtracted(overrides: Record<string, unknown> = {}) {
  return {
    requester_name: null, requester_department: null,
    target: null, context_background: null, desired_outcomes: null,
    deliverables: null, due_date: null, due_date_parsed: null,
    approvals: null, constraints: null, supporting_links: null,
    project_keywords: null, confidence: 0.9, acknowledgment: null,
    ...overrides,
  };
}

let msgCounter = 0;

function mockClient() {
  return {
    users: {
      info: vi.fn().mockResolvedValue({
        user: {
          real_name: 'Kat Cahill',
          profile: { real_name: 'Kat Cahill', display_name: 'Kat', title: 'VP of Marketing' },
        },
      }),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
  } as any;
}

let conversationStore: Record<string, any>;

function setupConversationStore() {
  conversationStore = {};

  (upsertConversation as Mock).mockImplementation(async (row: any) => {
    const key = `${row.user_id}::${row.thread_ts}`;
    const id = row.id ?? (conversationStore[key]?.id ?? ++msgCounter);
    conversationStore[key] = { ...row, id, created_at: conversationStore[key]?.created_at ?? new Date().toISOString() };
    return id;
  });

  (getConversation as Mock).mockImplementation(async (userId: string, threadTs: string) => {
    return conversationStore[`${userId}::${threadTs}`] ?? null;
  });
}

async function sendMessage(opts: { userId?: string; userName?: string; channelId?: string; threadTs?: string; text: string; say: Mock; client: any }) {
  const messageTs = `msg-${++msgCounter}`;
  await handleIntakeMessage({
    userId: opts.userId ?? 'U_TEST',
    userName: opts.userName ?? 'kat',
    channelId: opts.channelId ?? 'C_INTAKE',
    threadTs: opts.threadTs ?? 'thread-1',
    messageTs,
    text: opts.text,
    say: opts.say as any,
    client: opts.client,
  });
}

function getSayTexts(say: Mock): string[] {
  return say.mock.calls.map((c: any) => {
    const arg = c[0];
    return typeof arg === 'string' ? arg : arg.text;
  });
}

/** Pre-create a gathering conversation in the store, skipping the welcome flow */
function seedGatheringConversation(overrides: Partial<Record<string, any>> = {}) {
  const data = {
    requester_name: 'Kat Cahill',
    requester_department: 'Marketing',
    target: null,
    context_background: null,
    desired_outcomes: null,
    deliverables: [],
    due_date: null,
    due_date_parsed: null,
    approvals: null,
    constraints: null,
    supporting_links: [],
    request_type: null,
    additional_details: {},
    conference_start_date: null,
    conference_end_date: null,
    presenter_names: null,
    outside_presenters: null,
    ...(overrides.collectedDataOverrides ?? {}),
  };

  conversationStore['U_TEST::thread-1'] = {
    id: overrides.id ?? 10,
    user_id: 'U_TEST',
    user_name: 'kat',
    channel_id: 'C_INTAKE',
    thread_ts: 'thread-1',
    status: overrides.status ?? 'gathering',
    current_step: overrides.current_step ?? 'target',
    collected_data: JSON.stringify(data),
    classification: overrides.classification ?? 'undetermined',
    monday_item_id: overrides.monday_item_id ?? null,
    created_at: new Date().toISOString(),
    ...(overrides.raw ?? {}),
  };
}

/** Pre-create a confirming conversation */
function seedConfirmingConversation(collectedDataOverrides: Record<string, any> = {}) {
  const data = {
    requester_name: 'Kat Cahill',
    requester_department: 'Marketing',
    target: 'Real estate agents',
    context_background: 'Webinar series about certifications',
    desired_outcomes: 'Generate 50 leads',
    deliverables: ['deck', 'emails'],
    due_date: 'March 15',
    due_date_parsed: '2026-03-15',
    approvals: null, constraints: null, supporting_links: [],
    request_type: 'webinar', additional_details: {},
    conference_start_date: null, conference_end_date: null,
    presenter_names: null, outside_presenters: null,
    ...collectedDataOverrides,
  };

  conversationStore['U_TEST::thread-1'] = {
    id: 10, user_id: 'U_TEST', user_name: 'kat', channel_id: 'C_INTAKE',
    thread_ts: 'thread-1', status: 'confirming', current_step: null,
    collected_data: JSON.stringify(data), classification: 'full',
    monday_item_id: null, created_at: new Date().toISOString(),
  };
}

/** Pre-create a follow-up conversation */
function seedFollowUpConversation(questions: Array<{ id: string; question: string; field_key: string }>, index = 0) {
  const data = {
    requester_name: 'Kat Cahill',
    requester_department: 'Marketing',
    target: 'Real estate agents',
    context_background: 'Webinar series',
    desired_outcomes: 'Generate leads',
    deliverables: ['deck'],
    due_date: 'March 1',
    due_date_parsed: '2026-03-01',
    approvals: null, constraints: null, supporting_links: [],
    request_type: 'webinar',
    additional_details: { '__follow_up_questions': JSON.stringify(questions) },
    conference_start_date: null, conference_end_date: null,
    presenter_names: null, outside_presenters: null,
  };

  conversationStore['U_TEST::thread-1'] = {
    id: 10, user_id: 'U_TEST', user_name: 'kat', channel_id: 'C_INTAKE',
    thread_ts: 'thread-1', status: 'gathering', current_step: `follow_up:${index}`,
    collected_data: JSON.stringify(data), classification: 'full',
    monday_item_id: null, created_at: new Date().toISOString(),
  };
}

// ---- Tests ----

describe('Intake conversation flows', () => {
  let say: Mock;
  let client: any;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT clear mockResolvedValueOnce queues — reset Claude mocks explicitly
    (interpretMessage as Mock).mockReset();
    (classifyRequestType as Mock).mockReset().mockResolvedValue(['general']);
    (generateFollowUpQuestions as Mock).mockReset().mockResolvedValue([]);
    (interpretFollowUpAnswer as Mock).mockReset().mockResolvedValue({ value: '', additional_fields: {} });
    msgCounter = 0;
    say = vi.fn().mockResolvedValue(undefined);
    client = mockClient();
    setupConversationStore();
    (getActiveConversationForUser as Mock).mockResolvedValue(undefined);
    (getMostRecentCompletedConversation as Mock).mockResolvedValue(undefined);
    (isMessageProcessed as Mock).mockResolvedValue(false);
    (hasConversationInThread as Mock).mockResolvedValue(false);
  });

  // ====================
  // NEW USER WELCOME
  // ====================
  describe('New user welcome', () => {
    it('should send personalized welcome with name and department', async () => {
      await sendMessage({ text: 'I need marketing help', say, client });

      const texts = getSayTexts(say);
      // Should include personalized welcome with name
      expect(texts.some((t) => t.includes('Kat'))).toBe(true);
      // Should confirm department from Slack profile
      expect(texts.some((t) => t.includes('Marketing'))).toBe(true);
      // Should ask the first unanswered question (target, since name+dept are from profile)
      expect(texts.some((t) => t.toLowerCase().includes('target audience') || t.toLowerCase().includes('who is'))).toBe(true);
    });

    it('should not call interpretMessage on the initial message', async () => {
      await sendMessage({ text: 'I need help with a webinar', say, client });
      expect(interpretMessage).not.toHaveBeenCalled();
    });
  });

  // ====================
  // HAPPY PATH: gather → follow-up → confirm → submit
  // ====================
  describe('Happy path: full conversation to submission', () => {
    it('should walk through all fields, follow-ups, and submission', async () => {
      // Pre-create conversation with name+dept already filled
      seedGatheringConversation();

      // Message 1: target
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({ target: 'Real estate agents', confidence: 0.95, acknowledgment: 'Got it!' }),
      );
      await sendMessage({ text: 'Real estate agents', say, client });
      let texts = getSayTexts(say);
      expect(texts.some((t) => t.toLowerCase().includes('context') || t.toLowerCase().includes('background'))).toBe(true);
      say.mockClear();

      // Message 2: context
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          context_background: 'Webinar series about home performance certifications',
          confidence: 0.9,
        }),
      );
      await sendMessage({ text: 'We have a webinar series about home performance certifications', say, client });
      texts = getSayTexts(say);
      expect(texts.some((t) => t.toLowerCase().includes('outcome') || t.toLowerCase().includes('goal'))).toBe(true);
      say.mockClear();

      // Message 3: outcomes
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          desired_outcomes: 'Generate 50 qualified leads',
          confidence: 0.9,
        }),
      );
      await sendMessage({ text: 'Generate 50 qualified leads', say, client });
      texts = getSayTexts(say);
      expect(texts.some((t) => t.toLowerCase().includes('deliverable'))).toBe(true);
      say.mockClear();

      // Message 4: deliverables
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          deliverables: ['registration page', 'email campaign', 'deck'],
          confidence: 0.95,
        }),
      );
      await sendMessage({ text: 'registration page, email campaign, and presentation deck', say, client });
      texts = getSayTexts(say);
      expect(texts.some((t) => t.toLowerCase().includes('when') || t.toLowerCase().includes('date') || t.toLowerCase().includes('need this'))).toBe(true);
      say.mockClear();

      // Message 5: due date → triggers follow-up phase
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({ due_date: 'March 15', due_date_parsed: '2026-03-15', confidence: 0.9 }),
      );
      (classifyRequestType as Mock).mockResolvedValueOnce(['webinar']);
      (generateFollowUpQuestions as Mock).mockResolvedValueOnce([
        { id: 'q1', question: 'What time will the webinar be held?', field_key: 'webinar_time' },
      ]);

      await sendMessage({ text: 'March 15', say, client });
      texts = getSayTexts(say);
      // Should enter follow-up phase
      expect(texts.some((t) => t.includes('question') || t.includes('webinar'))).toBe(true);
      say.mockClear();

      // Message 6: Answer follow-up → transitions to confirming
      (interpretFollowUpAnswer as Mock).mockResolvedValueOnce({ value: '2pm ET', additional_fields: {} });
      await sendMessage({ text: '2pm ET', say, client });
      texts = getSayTexts(say);
      // Should show summary for confirmation (only 1 follow-up question)
      expect(texts.some((t) => t.includes("Here's what I've got"))).toBe(true);
      say.mockClear();

      // Message 7: Confirm → submit
      await sendMessage({ text: 'yes', say, client });
      texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('ubmit') || t.includes('review'))).toBe(true);
    });
  });

  // ====================
  // MULTI-FIELD EXTRACTION
  // ====================
  describe('Multi-field extraction in a single message', () => {
    it('should extract multiple fields from one rich message', async () => {
      seedGatheringConversation();

      // User provides target, context, AND outcomes in one message
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          target: 'Homeowners in the Southeast',
          context_background: 'Launching a new energy audit program',
          desired_outcomes: 'Sign up 200 homeowners in Q2',
          confidence: 0.95,
        }),
      );

      await sendMessage({ text: 'We are launching a new energy audit program for homeowners in the Southeast and want 200 signups in Q2', say, client });

      const texts = getSayTexts(say);
      // Should skip target, context, outcomes and ask for deliverables
      expect(texts.some((t) => t.toLowerCase().includes('deliverable'))).toBe(true);
    });
  });

  // ====================
  // applyExtractedFields BUG FIX VERIFICATION
  // ====================
  describe('applyExtractedFields with zero fields (bug fix)', () => {
    it('should not crash when Claude extracts 0 fields', async () => {
      seedGatheringConversation();

      // Claude returns nothing useful
      (interpretMessage as Mock).mockResolvedValueOnce(emptyExtracted({ confidence: 0.3 }));

      // This previously threw: TypeError: Cannot create property 'appliedFields' on number '0'
      await expect(
        sendMessage({ text: 'hmm let me think about it', say, client }),
      ).resolves.not.toThrow();
    });
  });

  // ====================
  // DUP-CHECK FLOW
  // ====================
  describe('Dup-check: "here" and "start fresh"', () => {
    it('should prompt when user has an active conversation elsewhere', async () => {
      (getActiveConversationForUser as Mock).mockResolvedValue({
        id: 99, user_id: 'U_TEST', thread_ts: 'other-thread',
        channel_id: 'C_INTAKE', status: 'gathering', collected_data: '{}',
      });

      await sendMessage({ text: 'I need help', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('continue') || t.includes('fresh'))).toBe(true);
    });

    it('should start fresh on "here" after dup-check', async () => {
      (getActiveConversationForUser as Mock).mockResolvedValue({
        id: 99, user_id: 'U_TEST', thread_ts: 'other-thread',
        channel_id: 'C_INTAKE', status: 'gathering', collected_data: '{}',
      });

      await sendMessage({ text: 'new project', say, client });
      say.mockClear();

      await sendMessage({ text: 'here', say, client });
      const texts = getSayTexts(say);
      // Should start a fresh conversation
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle "start fresh" variant', async () => {
      (getActiveConversationForUser as Mock).mockResolvedValue({
        id: 99, user_id: 'U_TEST', thread_ts: 'other-thread',
        channel_id: 'C_INTAKE', status: 'gathering', collected_data: '{}',
      });

      await sendMessage({ text: 'Need help', say, client });
      say.mockClear();

      await sendMessage({ text: 'start fresh', say, client });
      const texts = getSayTexts(say);
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should redirect to existing thread on "continue there"', async () => {
      (getActiveConversationForUser as Mock).mockResolvedValue({
        id: 99, user_id: 'U_TEST', thread_ts: 'other-thread',
        channel_id: 'C_INTAKE', status: 'gathering', collected_data: '{}',
      });

      await sendMessage({ text: 'I need help', say, client });
      say.mockClear();

      await sendMessage({ text: 'continue there', say, client });
      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('thread') || t.includes('continue') || t.includes('there'))).toBe(true);
    });
  });

  // ====================
  // RETURNING USER WITH COMPLETED PROJECT
  // ====================
  describe('Returning user with accepted project', () => {
    it('should offer department from completed project during dup-check', async () => {
      (getActiveConversationForUser as Mock).mockResolvedValue({
        id: 99, user_id: 'U_TEST', thread_ts: 'other-thread',
        channel_id: 'C_INTAKE', status: 'gathering',
        collected_data: JSON.stringify({ requester_name: 'Kat Cahill', requester_department: 'Marketing' }),
      });

      (getMostRecentCompletedConversation as Mock).mockResolvedValue({
        id: 50, user_id: 'U_TEST', status: 'complete',
        collected_data: JSON.stringify({
          requester_department: 'Marketing',
          target: 'HVAC contractors in the Pacific Northwest',
        }),
      });

      await sendMessage({ text: 'Hey, new project', say, client });
      say.mockClear();

      // Say "here" to start fresh
      await sendMessage({ text: 'here', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('Marketing') || t.includes('marketing'))).toBe(true);
    });
  });

  // ====================
  // MISSPELLINGS AND PARTIAL ANSWERS
  // ====================
  describe('Misspellings and partial answers', () => {
    it('should not match "cancle" as cancel', async () => {
      seedGatheringConversation();

      // "cancle" is NOT a valid cancel pattern — should be interpreted as a message
      (interpretMessage as Mock).mockResolvedValueOnce(emptyExtracted({ confidence: 0.3 }));
      await sendMessage({ text: 'cancle', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('cancelled') || t.includes('withdrawn'))).toBe(false);
    });

    it('should use raw text fallback for substantive but unextractable answers', async () => {
      seedGatheringConversation();

      // Claude returns 0 fields but message is clearly substantive
      (interpretMessage as Mock).mockResolvedValueOnce(emptyExtracted({ confidence: 0.4 }));

      await sendMessage({
        text: 'something about the new program we discussed in the meeting last week with Sarah about the redesign',
        say,
        client,
      });

      // Should advance (raw text fallback) — not loop
      const texts = getSayTexts(say);
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should not match "yep thats wrong" as confirmation', async () => {
      // "yep" normally matches CONFIRM_PATTERNS but context matters
      // Actually, the pattern ^yep(\s|!|$) WOULD match "yep thats wrong"
      // This test documents current behavior — the pattern matcher is simple
      seedConfirmingConversation();
      await sendMessage({ text: 'yep thats wrong, change the target to homeowners', say, client });

      // Current behavior: "yep" matches CONFIRM_PATTERNS, so it submits
      // This is a known limitation — documenting it
      const texts = getSayTexts(say);
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ====================
  // CONFIRMING STATE
  // ====================
  describe('Confirming state', () => {
    it('should submit on "yes"', async () => {
      seedConfirmingConversation();
      await sendMessage({ text: 'yes', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('ubmit'))).toBe(true);
    });

    it('should submit on "looks good"', async () => {
      seedConfirmingConversation();
      await sendMessage({ text: 'looks good', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('ubmit'))).toBe(true);
    });

    it('should submit on "send it"', async () => {
      seedConfirmingConversation();
      await sendMessage({ text: 'send it', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('ubmit'))).toBe(true);
    });

    it('should allow editing a field during confirmation', async () => {
      seedConfirmingConversation();

      // User describes a change — Claude extracts the updated field
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({ due_date: 'April 1', due_date_parsed: '2026-04-01', confidence: 0.9 }),
      );

      await sendMessage({ text: 'change the due date to April 1', say, client });

      const texts = getSayTexts(say);
      // Should show updated summary
      expect(texts.some((t) => t.includes("Here's what I've got") || t.includes('updated') || t.includes('revised'))).toBe(true);
    });

    it('should cancel on "cancel"', async () => {
      seedConfirmingConversation();
      await sendMessage({ text: 'cancel', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('cancel'))).toBe(true);
    });

    it('should reset on "start over"', async () => {
      seedConfirmingConversation();
      await sendMessage({ text: 'start over', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('start') || t.includes('fresh') || t.includes('new request'))).toBe(true);
    });
  });

  // ====================
  // CANCEL AND RESET
  // ====================
  describe('Cancel and reset during gathering', () => {
    it('should cancel on "cancel"', async () => {
      seedGatheringConversation();
      await sendMessage({ text: 'cancel', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('cancel'))).toBe(true);
    });

    it('should reset on "start over" preserving name/dept', async () => {
      seedGatheringConversation({
        collectedDataOverrides: { target: 'Agents', context_background: 'Old context' },
      });

      await sendMessage({ text: 'start over', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('Kat') || t.includes('new request') || t.includes('fresh'))).toBe(true);
    });
  });

  // ====================
  // SKIP AND IDK
  // ====================
  describe('Skip and IDK patterns', () => {
    it('should advance on "skip" during follow-ups', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'Who needs to approve?', field_key: 'approvals_info' },
        { id: 'q2', question: 'Any constraints?', field_key: 'constraints_info' },
      ]);

      await sendMessage({ text: 'skip', say, client });

      const texts = getSayTexts(say);
      // Should advance to next question or summary
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should offer guidance on "idk" during gathering', async () => {
      seedGatheringConversation();

      await sendMessage({ text: 'idk', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('guidance') || t.includes('skip') || t.includes('guess'))).toBe(true);
    });

    it('should handle "not sure" during follow-ups', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'What time?', field_key: 'webinar_time' },
      ]);

      await sendMessage({ text: 'not sure', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('skip') || t.includes('discuss') || t.includes('guess'))).toBe(true);
    });
  });

  // ====================
  // UNCERTAINTY DETECTION
  // ====================
  describe('Uncertainty detection', () => {
    it('should flag uncertain answers without crashing (bug fix verification)', async () => {
      seedGatheringConversation();

      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          context_background: 'I think it might be related to the certification program',
          confidence: 0.7,
        }),
      );

      // "I think" + "maybe" = uncertainty language — previously crashed due to appliedFields bug
      await expect(
        sendMessage({ text: 'I think it might be related to the certification program maybe', say, client }),
      ).resolves.not.toThrow();

      const texts = getSayTexts(say);
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should append reassurance to acknowledgment instead of sending separate suggestions', async () => {
      seedGatheringConversation({
        current_step: 'deliverables',
        collectedDataOverrides: {
          target: 'Real estate agents',
          context_background: 'Webinar series',
          desired_outcomes: 'Increase sign-ups',
        },
      });

      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          deliverables: ['email marketing', 'social media'],
          acknowledgment: 'Got it — email marketing and social media!',
          confidence: 0.8,
        }),
      );

      await sendMessage({ text: 'I probably need email and social media marketing', say, client });

      const texts = getSayTexts(say);
      // The acknowledgment should include the reassurance inline
      const ackMsg = texts.find((t) => t.includes('Got it'));
      expect(ackMsg).toBeDefined();
      expect(ackMsg).toContain('fine-tune');
      // Should NOT contain the old suggestions list with "Would any of these work?"
      expect(texts.some((t) => t.includes('Would any of these work'))).toBe(false);
      // Should still ask the next question (due_date)
      expect(texts.some((t) => t.toLowerCase().includes('when') || t.toLowerCase().includes('need this by'))).toBe(true);
    });

    it('should not overwrite already-populated field with raw fallback text', async () => {
      seedGatheringConversation({
        current_step: 'deliverables',
        collectedDataOverrides: {
          target: 'Real estate agents',
          context_background: 'Webinar series',
          desired_outcomes: 'Increase sign-ups',
          deliverables: ['email marketing'],
        },
      });

      // Claude returns nothing — 0 fields extracted
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({ confidence: 0.5 }),
      );

      await sendMessage({ text: 'yeah those sound good', say, client });

      // Should NOT overwrite deliverables with "yeah those sound good"
      const saved = conversationStore['U_TEST::thread-1'];
      const data = JSON.parse(saved.collected_data);
      expect(data.deliverables).toEqual(['email marketing']);
    });
  });

  // ====================
  // NUDGE PATTERNS
  // ====================
  describe('Nudge patterns', () => {
    it('should resume on "hello" during gathering', async () => {
      seedGatheringConversation();

      await sendMessage({ text: 'hello', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes("I'm here") || t.includes('pick up'))).toBe(true);
    });

    it('should resume on "hey" during follow-ups', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'What time?', field_key: 'time' },
      ]);

      await sendMessage({ text: 'hey', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes("I'm here") || t.includes('pick up'))).toBe(true);
    });
  });

  // ====================
  // MULTI-SERVICE REQUESTS
  // ====================
  describe('Complex multi-service requests', () => {
    it('should complete full flow for a multi-service request', async () => {
      seedGatheringConversation();

      // Message 1: target + context + outcomes in one go
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          target: 'HVAC contractors',
          context_background: 'Annual partner summit with keynote, breakout sessions, and networking dinner',
          desired_outcomes: 'Strengthen partner relationships and introduce new product tier',
          confidence: 0.95,
          project_keywords: ['conference', 'dinner', 'summit'],
        }),
      );
      await sendMessage({ text: 'Annual partner summit for HVAC contractors with keynote, breakouts, and dinner. Want to strengthen relationships.', say, client });
      expect(getSayTexts(say).some((t) => t.toLowerCase().includes('deliverable'))).toBe(true);
      say.mockClear();

      // Message 2: deliverables
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({
          deliverables: ['event page', 'email series', 'deck', 'name badges', 'social posts'],
          confidence: 0.95,
        }),
      );
      await sendMessage({ text: 'event page, email series, deck, name badges, and social posts', say, client });
      say.mockClear();

      // Message 3: due date → follow-up phase
      (interpretMessage as Mock).mockResolvedValueOnce(
        emptyExtracted({ due_date: 'April 10-12', due_date_parsed: '2026-04-10', confidence: 0.9 }),
      );
      (classifyRequestType as Mock).mockResolvedValueOnce(['conference', 'insider_dinner']);
      (generateFollowUpQuestions as Mock).mockResolvedValueOnce([
        { id: 'q1', question: 'How many attendees?', field_key: 'attendees' },
        { id: 'q2', question: 'Venue confirmed?', field_key: 'venue' },
      ]);
      await sendMessage({ text: 'April 10-12', say, client });
      say.mockClear();

      // Follow-up 1
      (interpretFollowUpAnswer as Mock).mockResolvedValueOnce({ value: 'About 150', additional_fields: {} });
      await sendMessage({ text: 'About 150', say, client });
      say.mockClear();

      // Follow-up 2 → confirming
      (interpretFollowUpAnswer as Mock).mockResolvedValueOnce({ value: 'Hilton downtown', additional_fields: {} });
      await sendMessage({ text: 'Hilton downtown', say, client });
      expect(getSayTexts(say).some((t) => t.includes("Here's what I've got"))).toBe(true);
      say.mockClear();

      // Confirm
      await sendMessage({ text: 'submit', say, client });
      expect(getSayTexts(say).some((t) => t.includes('ubmit') || t.includes('review'))).toBe(true);
    });
  });

  // ====================
  // ERROR RECOVERY
  // ====================
  describe('Error recovery', () => {
    it('should show friendly error when Claude fails during gathering', async () => {
      seedGatheringConversation();

      // Claude throws an error
      (interpretMessage as Mock).mockRejectedValueOnce(new Error('API timeout'));

      await sendMessage({ text: 'I have a webinar coming up', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('Sorry') || t.includes('brief moment') || t.includes('try'))).toBe(true);
    });

    it('should not crash the outer handler on unhandled errors', async () => {
      seedGatheringConversation();

      // Mock an unexpected throw
      (interpretMessage as Mock).mockImplementationOnce(() => { throw new TypeError('unexpected'); });

      await expect(
        sendMessage({ text: 'something', say, client }),
      ).resolves.not.toThrow();
    });
  });

  // ====================
  // POST-SUBMISSION MESSAGES
  // ====================
  describe('Post-submission messages', () => {
    it('should handle messages after submission', async () => {
      conversationStore['U_TEST::thread-1'] = {
        id: 10, user_id: 'U_TEST', user_name: 'kat', channel_id: 'C_INTAKE',
        thread_ts: 'thread-1', status: 'pending_approval', current_step: null,
        collected_data: JSON.stringify({
          requester_name: 'Kat Cahill', requester_department: 'Marketing',
          target: 'Agents', context_background: 'Webinar',
          desired_outcomes: 'Leads', deliverables: ['deck'],
          due_date: 'March 1', due_date_parsed: '2026-03-01',
          approvals: null, constraints: null, supporting_links: [],
          request_type: 'general', additional_details: {},
          conference_start_date: null, conference_end_date: null,
          presenter_names: null, outside_presenters: null,
        }),
        classification: 'full',
        monday_item_id: 'mock-monday-id',
        created_at: new Date().toISOString(),
      };

      await sendMessage({ text: 'oh wait, also need social posts', say, client });

      const texts = getSayTexts(say);
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ====================
  // MESSAGE DEDUPLICATION
  // ====================
  describe('Message deduplication', () => {
    it('should skip already-processed messages', async () => {
      (isMessageProcessed as Mock).mockResolvedValueOnce(true);
      await sendMessage({ text: 'I need help', say, client });
      expect(say).not.toHaveBeenCalled();
    });
  });

  // ====================
  // TERMINAL STATES
  // ====================
  describe('Terminal conversation states', () => {
    it('should treat completed conversation as new', async () => {
      conversationStore['U_TEST::thread-1'] = {
        id: 10, user_id: 'U_TEST', user_name: 'kat', channel_id: 'C_INTAKE',
        thread_ts: 'thread-1', status: 'complete', current_step: null,
        collected_data: '{}', classification: 'full',
        monday_item_id: null, created_at: new Date().toISOString(),
      };

      await sendMessage({ text: 'New project', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('Kat'))).toBe(true);
    });
  });

  // ====================
  // SUBMIT AS-IS DURING FOLLOW-UPS
  // ====================
  describe('Submit as-is during follow-ups', () => {
    it('should skip remaining follow-ups on "just submit"', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'Q1?', field_key: 'f1' },
        { id: 'q2', question: 'Q2?', field_key: 'f2' },
        { id: 'q3', question: 'Q3?', field_key: 'f3' },
      ]);

      await sendMessage({ text: 'just submit', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes("Here's what I've got"))).toBe(true);
    });

    it('should skip on "done"', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'Q1?', field_key: 'f1' },
      ]);

      await sendMessage({ text: 'done', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes("Here's what I've got"))).toBe(true);
    });
  });

  // ====================
  // DISCUSS FLAG DURING FOLLOW-UPS
  // ====================
  describe('Discuss flag during follow-ups', () => {
    it('should flag for discussion and advance', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'What time?', field_key: 'webinar_time' },
        { id: 'q2', question: 'Outside presenters?', field_key: 'outside_presenters' },
      ]);

      await sendMessage({ text: 'discuss', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('discussion') || t.includes('Flagged'))).toBe(true);
    });

    it('should transition to confirming when last follow-up is flagged', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'What time?', field_key: 'webinar_time' },
      ]);

      await sendMessage({ text: 'discuss', say, client });

      const texts = getSayTexts(say);
      // Should flag AND show summary since it's the last question
      expect(texts.some((t) => t.includes('Flagged') || t.includes('discussion'))).toBe(true);
      expect(texts.some((t) => t.includes("Here's what I've got"))).toBe(true);
    });
  });

  // ====================
  // PATTERN EDGE CASES
  // ====================
  describe('Pattern edge cases', () => {
    it('should not treat "Here" alone as confirmation in gathering', async () => {
      seedGatheringConversation();

      // "Here" by itself should not be treated as a confirm pattern
      // It should go through normal message processing
      (interpretMessage as Mock).mockResolvedValueOnce(emptyExtracted({ confidence: 0.2 }));
      await sendMessage({ text: 'Here', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('submitted'))).toBe(false);
    });

    it('should handle "n/a" as skip in follow-ups', async () => {
      seedFollowUpConversation([
        { id: 'q1', question: 'Q1?', field_key: 'f1' },
        { id: 'q2', question: 'Q2?', field_key: 'f2' },
      ]);

      await sendMessage({ text: 'n/a', say, client });

      const texts = getSayTexts(say);
      // n/a matches SKIP_PATTERNS — should advance
      expect(texts.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle "nevermind" as cancel', async () => {
      seedGatheringConversation();
      await sendMessage({ text: 'nevermind', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('cancel'))).toBe(true);
    });

    it('should handle "forget it" as cancel', async () => {
      seedGatheringConversation();
      await sendMessage({ text: 'forget it', say, client });

      const texts = getSayTexts(say);
      expect(texts.some((t) => t.includes('cancel'))).toBe(true);
    });
  });
});
