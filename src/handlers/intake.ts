import type { App, SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager, type CollectedData } from '../lib/conversation';
import { interpretMessage, classifyRequest, classifyRequestType, generateFollowUpQuestions, interpretFollowUpAnswer, type ExtractedFields, type FollowUpQuestion } from '../lib/claude';
import { generateFieldGuidance } from '../lib/guidance';
import { generateProductionTimeline } from '../lib/timeline';
import { sendApprovalRequest } from './approval';
import { getActiveConversationForUser, getConversationById, cancelConversation, updateTriageInfo } from '../lib/db';
import { createMondayItemForReview } from '../lib/workflow';
import { addMondayItemUpdate, updateMondayItemStatus } from '../lib/monday';

// --- Confirmation keywords ---

const CONFIRM_PATTERNS = [/^y(es)?$/i, /^confirm$/i, /^submit$/i, /^looks?\s*good$/i, /^correct$/i, /^that'?s?\s*right$/i, /^yep$/i, /^yeah$/i];
const CANCEL_PATTERNS = [/^cancel$/i, /^nevermind$/i, /^never\s*mind$/i, /^forget\s*it$/i, /^nvm$/i];
const RESET_PATTERNS = [/^start\s*over$/i, /^reset$/i, /^restart$/i, /^from\s*scratch$/i];
const CONTINUE_PATTERNS = [/^continue$/i, /^resume$/i, /^pick\s*up$/i, /^keep\s*going$/i];
const CONTINUE_THERE_PATTERNS = [/^continue\s*there$/i, /^go\s*there$/i, /^that\s*one$/i, /^use\s*that$/i];
const START_FRESH_PATTERNS = [/^start\s*fresh$/i, /^new\s*one$/i, /^start\s*(a\s*)?new$/i, /^fresh$/i];
const SUBMIT_AS_IS_PATTERNS = [/^submit\s*as[\s-]*is$/i, /^just\s*submit$/i, /^submit\s*now$/i];
const SKIP_PATTERNS = [/^skip$/i, /^skip\s*this$/i, /^pass$/i, /^next$/i];
const DONE_PATTERNS = [/^done$/i, /^that'?s?\s*all$/i, /^no\s*more$/i, /^nothing\s*(else)?$/i];
const IDK_PATTERNS = [
  /^i\s*don['\u2019]?t\s*know/i, /^not\s*sure/i, /^no\s*idea/i, /^unsure$/i,
  /^idk$/i, /^no\s*clue/i, /^i['\u2019]?m\s*not\s*sure/i, /^haven['\u2019]?t\s*decided/i,
  /^good\s*question/i, /^help\s*me\s*decide/i, /^i\s*have\s*no\s*idea/i,
  /^dunno/i, /^beats\s*me/i, /^not\s*certain/i, /^no\s*preference/i,
  /^hmm+/i, /^i['\u2019]?m\s*unsure/i,
];
const DISCUSS_PATTERNS = [
  /^discuss$/i, /^let['\u2019]?s\s*discuss/i, /^need\s*to\s*(talk|discuss|chat)/i,
  /^want\s*to\s*(talk|discuss|chat)/i, /^can\s*we\s*(talk|discuss|chat)/i,
  /^flag\s*(this|it)?/i, /^needs?\s*discussion/i, /^talk\s*(about\s*)?(this|it)/i,
  /^let['\u2019]?s\s*talk/i, /^come\s*back\s*to\s*(this|it)/i,
  /^not\s*sure.*talk/i, /^circle\s*back/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  const trimmed = text.trim();
  return patterns.some((p) => p.test(trimmed));
}

/**
 * Tracks users who were asked about a duplicate active conversation.
 * Maps userId → the existing conversation's thread_ts, channel_id, and the thread where the prompt was shown.
 */
const pendingDuplicateChecks = new Map<string, { existingThreadTs: string; existingChannelId: string; existingConvoId: number; promptThreadTs: string }>();

/**
 * Deduplication: tracks recently processed message timestamps to prevent
 * double-processing when both app_mention and message events fire for the same message.
 */
const recentlyProcessed = new Set<string>();
const DEDUP_TTL_MS = 30_000; // 30 seconds

/** Check if a user has a pending duplicate-conversation prompt. */
export function hasPendingDuplicateCheck(userId: string, _threadTs: string): boolean {
  return pendingDuplicateChecks.has(userId);
}

// --- Public handler ---

/**
 * Handle an incoming message in the context of an intake conversation.
 * This is the main entry point called from mention/message handlers.
 */
export async function handleIntakeMessage(opts: {
  userId: string;
  userName: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  text: string;
  say: SayFn;
  client: WebClient;
}): Promise<void> {
  const { userId, userName, channelId, threadTs, messageTs, text, say, client } = opts;

  // Deduplicate: skip if this exact message was already processed
  // (happens when both app_mention and message events fire for the same @mention in a thread)
  if (recentlyProcessed.has(messageTs)) {
    console.log(`[intake] Skipping duplicate message ${messageTs}`);
    return;
  }
  recentlyProcessed.add(messageTs);
  setTimeout(() => recentlyProcessed.delete(messageTs), DEDUP_TTL_MS);

  try {
    await handleIntakeMessageInner({ userId, userName, channelId, threadTs, text, say, client });
  } catch (err) {
    console.error('[intake] Unhandled error in intake handler:', err);
    const formFallback = config.intakeFormUrl ? ` You can also fill out the form instead: ${config.intakeFormUrl}` : '';
    try {
      await say({
        text: `Something went wrong while processing your request. Your information has been saved.${formFallback}\nIf you need immediate help, tag someone from the marketing team in #marcoms-requests.`,
        thread_ts: threadTs,
      });
    } catch (sayErr) {
      console.error('[intake] Failed to send error message to user:', sayErr);
    }
  }
}

async function handleIntakeMessageInner(opts: {
  userId: string;
  userName: string;
  channelId: string;
  threadTs: string;
  text: string;
  say: SayFn;
  client: WebClient;
}): Promise<void> {
  const { userId, userName, channelId, threadTs, text: rawText, say, client } = opts;

  // Strip bot mentions (e.g., "<@U123ABC>") so pattern matching works on the actual message
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  // --- Handle pending duplicate-check responses ---
  const pendingDup = pendingDuplicateChecks.get(userId);
  if (pendingDup) {
    const replyThreadTs = pendingDup.promptThreadTs;
    if (matchesAny(text, CONTINUE_THERE_PATTERNS)) {
      pendingDuplicateChecks.delete(userId);
      // Build a Slack deep link to the original thread
      const tsNoDot = pendingDup.existingThreadTs.replace('.', '');
      await say({
        text: `No problem! Here's your open conversation: https://slack.com/archives/${pendingDup.existingChannelId}/p${tsNoDot}\nJust reply there to pick up where you left off.`,
        thread_ts: replyThreadTs,
      });
      return;
    }
    if (matchesAny(text, START_FRESH_PATTERNS)) {
      pendingDuplicateChecks.delete(userId);
      // Cancel the old conversation and start a new one — fall through to create new conversation below
      await cancelConversation(pendingDup.existingConvoId);
    } else {
      pendingDuplicateChecks.delete(userId);
      // Unrecognized response — treat as "start fresh" since user is clearly trying to interact
      await cancelConversation(pendingDup.existingConvoId);
    }
  }

  // Load or create conversation
  let convo = await ConversationManager.load(userId, threadTs);
  console.log(`[intake] load(${userId}, ${threadTs}) → ${convo ? `found existing (status=${convo.getStatus()})` : 'no conversation'}`);

  // If the conversation in this thread is terminal, treat it as "no conversation" — user is starting fresh
  if (convo && (convo.getStatus() === 'complete' || convo.getStatus() === 'cancelled' || convo.getStatus() === 'withdrawn')) {
    console.log(`[intake] Conversation in thread ${threadTs} is ${convo.getStatus()}, treating as new`);
    convo = undefined;
  }

  if (!convo) {
    // Check for active conversation in another thread
    const existingConvo = await getActiveConversationForUser(userId, threadTs);
    console.log(`[intake] activeConversationForUser → ${existingConvo ? `found id=${existingConvo.id} thread=${existingConvo.thread_ts}` : 'none'}`);
    if (existingConvo) {
      // Store pending duplicate check and prompt user
      pendingDuplicateChecks.set(userId, {
        existingThreadTs: existingConvo.thread_ts,
        existingChannelId: existingConvo.channel_id,
        existingConvoId: existingConvo.id,
        promptThreadTs: threadTs,
      });
      await say({
        text: "Welcome back! It looks like you have an open request in another thread — would you like to *continue there* or *start fresh* here?",
        thread_ts: threadTs,
      });
      return;
    }

    // Look up the user's real name from Slack for the requester field
    let realName = 'Unknown';
    try {
      const userInfo = await client.users.info({ user: userId });
      realName = userInfo.user?.real_name ?? userInfo.user?.name ?? 'Unknown';
      console.log(`[intake] Resolved user name: ${realName}`);
    } catch (err) {
      console.error('[intake] Failed to look up user name for', userId, '— bot may need users:read scope. Error:', err);
    }

    convo = new ConversationManager({
      userId,
      userName: realName,
      channelId,
      threadTs,
    });
    // Auto-fill requester name from Slack
    convo.markFieldCollected('requester_name', realName);
    await convo.save();

    // Send a warm welcome before processing their message (randomized)
    console.log(`[intake] Sending welcome message in thread ${threadTs}`);
    const welcomeMessages = [
      "Hey! Thanks for reaching out to marketing. I'd love to help you with this. I'm going to ask you a few quick questions so I can get your request to the right people.",
      "Hi! Thanks for reaching out to the marketing team. To get things moving, I'll walk you through a few quick questions about your request.",
      "Hey there! Glad you reached out to marketing. I'll just need to ask you a few questions to make sure we have everything we need to get started.",
      "Hi there! Thanks for coming to us. Let me ask you a few quick questions so we can get your request set up and into the right hands.",
    ];
    await say({
      text: welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)],
      thread_ts: threadTs,
    });

    // Ask the first question and return — don't try to interpret the initial message as an answer
    await askNextQuestion(convo, threadTs, say);
    return;
  }

  const status = convo.getStatus();

  // --- Handle withdrawn conversations ---
  if (status === 'withdrawn') {
    await say({
      text: "This request was withdrawn. Start a new thread if you'd like to submit a new request!",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Handle completed/cancelled conversations ---
  if (status === 'cancelled') {
    await say({
      text: "This conversation was cancelled. Start a new thread if you'd like to submit a request!",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Handle post-submission states with buttons ---
  if (status === 'pending_approval' || status === 'complete') {
    await handlePostSubmissionMessage(convo, text, threadTs, say, client);
    return;
  }

  // --- Handle confirming state ---
  if (status === 'confirming') {
    await handleConfirmingState(convo, text, threadTs, say, client);
    return;
  }

  // --- Handle gathering state ---
  await handleGatheringState(convo, text, threadTs, say);
}

// --- State handlers ---

async function handleConfirmingState(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
  client: WebClient,
): Promise<void> {
  // Check for cancel
  if (matchesAny(text, CANCEL_PATTERNS)) {
    convo.setStatus('cancelled');
    await convo.save();
    await say({
      text: "No problem — request cancelled. If you change your mind, just start a new conversation!",
      thread_ts: threadTs,
    });
    return;
  }

  // Check for start over
  if (matchesAny(text, RESET_PATTERNS)) {
    convo.reset();
    await convo.save();
    await say({
      text: "Starting fresh! Let's begin again.",
      thread_ts: threadTs,
    });
    await askNextQuestion(convo, threadTs, say);
    return;
  }

  // Check for continue/resume (used after timeout reminders) — re-show summary
  if (matchesAny(text, CONTINUE_PATTERNS)) {
    await say({
      text: "Great, let's pick up where we left off! Here's what I have:",
      thread_ts: threadTs,
    });
    await say({
      text: convo.toSummary(),
      thread_ts: threadTs,
    });
    return;
  }

  // Check for confirmation
  if (matchesAny(text, CONFIRM_PATTERNS)) {
    await say({
      text: ':hourglass_flowing_sand: Submitting for review...',
      thread_ts: threadTs,
    });

    const classification = convo.getClassification();
    const effectiveClassification: 'quick' | 'full' =
      classification === 'undetermined' ? 'quick' : classification;

    const collectedData = convo.getCollectedData();
    const requesterName = convo.getUserName();

    // Create Monday.com item at submission time
    let mondayItemId: string | null = null;
    let mondayUrl: string | null = null;
    try {
      const mondayResult = await createMondayItemForReview({
        collectedData,
        classification: effectiveClassification,
        requesterName,
      });
      if (mondayResult.success && mondayResult.itemId) {
        mondayItemId = mondayResult.itemId;
        mondayUrl = mondayResult.boardUrl ?? null;
        convo.setMondayItemId(mondayResult.itemId);
      }
    } catch (err) {
      console.error('[intake] Failed to create Monday.com item at submission:', err);
    }

    // Set status to pending_approval
    convo.setStatus('pending_approval');
    await convo.save();

    // Tell requester it's submitted for review
    await say({
      text: ":white_check_mark: *Your request has been submitted for review!*\n\nThe marketing team will review your request and either approve it or reach out to discuss. I'll notify you once there's an update.",
      thread_ts: threadTs,
    });

    // Post approval request to #mktg-triage
    const projectName =
      collectedData.context_background?.slice(0, 80) ??
      collectedData.deliverables[0] ??
      'Untitled Request';

    try {
      await sendApprovalRequest(client, {
        conversationId: convo.getId()!,
        projectName,
        classification: effectiveClassification,
        collectedData,
        requesterName,
        mondayItemId,
        mondayUrl,
      });
    } catch (err) {
      console.error('[intake] Failed to send approval request:', err);
    }

    return;
  }

  // Check for IDK during confirmation — help the user think through what to change
  if (matchesAny(text, IDK_PATTERNS)) {
    await say({
      text: "No worries! Here are your options:\n\n• Reply *yes* to submit as-is\n• Tell me what you'd like to change (e.g., \"change the due date to March 15\")\n• Say *start over* to redo the whole request\n• Say *cancel* to scrap it\n\nWhat would you like to do?",
      thread_ts: threadTs,
    });
    return;
  }

  // User is describing changes — re-interpret and update
  try {
    const extracted = await interpretMessage(text, convo.getCollectedData());
    applyExtractedFields(convo, extracted);
    await convo.save();

    await say({
      text: "Got it, I've updated the request. Here's the revised summary:",
      thread_ts: threadTs,
    });
    await say({
      text: convo.toSummary(),
      thread_ts: threadTs,
    });
  } catch (error) {
    console.error('[intake] Claude interpretation error during confirmation:', error);
    const formFallback = config.intakeFormUrl ? `\nOr you can fill out the form instead: ${config.intakeFormUrl}` : '';
    await say({
      text: `I didn't quite catch that. You can reply *yes* to submit, describe what to change, say *start over*, or *cancel*.${formFallback}`,
      thread_ts: threadTs,
    });
  }
}

async function handleGatheringState(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  // Check for cancel
  if (matchesAny(text, CANCEL_PATTERNS)) {
    convo.setStatus('cancelled');
    await convo.save();
    await say({
      text: "No problem — request cancelled. If you change your mind, just start a new conversation!",
      thread_ts: threadTs,
    });
    return;
  }

  // Check for start over
  if (matchesAny(text, RESET_PATTERNS)) {
    convo.reset();
    await convo.save();
    await say({
      text: "Starting fresh! Let's begin again.",
      thread_ts: threadTs,
    });
    await askNextQuestion(convo, threadTs, say);
    return;
  }

  // Check for continue/resume (used after timeout reminders)
  if (matchesAny(text, CONTINUE_PATTERNS)) {
    await say({
      text: "Great, let's pick up where we left off!",
      thread_ts: threadTs,
    });
    if (convo.isInFollowUp()) {
      const questions = getStoredFollowUpQuestions(convo);
      const index = convo.getFollowUpIndex();
      if (questions && index < questions.length) {
        await askFollowUpQuestion(convo, index, questions, threadTs, say);
      } else {
        await transitionToConfirming(convo, threadTs, say);
      }
    } else {
      await askNextQuestion(convo, threadTs, say);
    }
    return;
  }

  // --- Handle follow-up phase ---
  if (convo.isInFollowUp()) {
    await handleFollowUpAnswer(convo, text, threadTs, say);
    return;
  }

  // --- IDK detection in gathering phase ---
  if (matchesAny(text, IDK_PATTERNS)) {
    const currentField = convo.getCurrentStep();
    if (currentField) {
      const guidance = await generateFieldGuidance(currentField, convo.getCollectedData());
      const calendarNote = config.marketingLeadCalendarUrl
        ? `\n\n_Or if you'd like to talk it through, <${config.marketingLeadCalendarUrl}|schedule time with marketing>._`
        : '';
      await say({ text: guidance + calendarNote, thread_ts: threadTs });
    } else {
      await say({
        text: "No worries — just tell me a bit about what you need and I'll help figure out the rest!",
        thread_ts: threadTs,
      });
    }
    return;
  }

  // --- "Needs discussion" flag in gathering phase ---
  if (matchesAny(text, DISCUSS_PATTERNS)) {
    const currentField = convo.getCurrentStep();
    if (currentField) {
      flagForDiscussion(convo, currentField, currentField);
      // Set a placeholder so the field counts as "answered" and we move on
      convo.markFieldCollected(currentField as keyof CollectedData, '_needs discussion_');
      await convo.save();
      const calendarLink = config.marketingLeadCalendarUrl
        ? ` You can also <${config.marketingLeadCalendarUrl}|schedule time with marketing> to talk it through.`
        : '';
      await say({
        text: `:speech_balloon: Flagged *${formatFieldLabel(currentField)}* for discussion — we'll make sure to cover it.${calendarLink} Let's keep going!`,
        thread_ts: threadTs,
      });
      // Ask the next question or transition
      if (convo.isComplete()) {
        await enterFollowUpPhase(convo, 1, threadTs, say);
      } else {
        await askNextQuestion(convo, threadTs, say);
      }
    }
    return;
  }

  // Interpret the message via Claude
  console.log(`[intake] Calling Claude to interpret: "${text.substring(0, 80)}" for convo threadTs=${convo.getThreadTs()}, replyThreadTs=${threadTs}`);
  try {
    const extracted = await interpretMessage(text, convo.getCollectedData(), undefined, convo.getCurrentStep());
    console.log(`[intake] Claude response: confidence=${extracted.confidence}, department=${extracted.requester_department}`);
    const fieldsApplied = applyExtractedFields(convo, extracted);

    if (fieldsApplied === 0) {
      console.log(`[intake] No fields applied (confidence=${extracted.confidence}, currentStep=${convo.getCurrentStep()})`);
      await say({
        text: "I didn't quite catch that. Could you rephrase?",
        thread_ts: threadTs,
      });
      // Re-ask the current question
      await askNextQuestion(convo, threadTs, say);
      return;
    }

    // Show production timeline if we just captured a due date
    if (extracted.due_date_parsed) {
      const timeline = generateProductionTimeline(convo.getCollectedData());
      if (timeline) {
        await say({ text: timeline, thread_ts: threadTs });
      }
    }

    // Check if all required fields are now collected
    if (convo.isComplete()) {
      // Enter follow-up phase
      await enterFollowUpPhase(convo, fieldsApplied, threadTs, say);
    } else {
      await convo.save();

      // Acknowledge what we captured if multiple fields came in
      if (fieldsApplied > 1) {
        await say({
          text: `Got it — captured ${fieldsApplied} details from that. Just a few more questions:`,
          thread_ts: threadTs,
        });
      }

      // Ask the next question
      await askNextQuestion(convo, threadTs, say);
    }
  } catch (error) {
    console.error('[intake] Claude interpretation error during gathering:', error);
    const formFallback = config.intakeFormUrl ? ` Or fill out the form instead: ${config.intakeFormUrl}` : '';
    await say({
      text: `I didn't quite catch that. Could you rephrase?${formFallback}\nIf you need immediate help, tag someone from the marketing team in #marcoms-requests.`,
      thread_ts: threadTs,
    });
    await askNextQuestion(convo, threadTs, say);
  }
}

// --- Follow-up phase ---

async function enterFollowUpPhase(
  convo: ConversationManager,
  fieldsApplied: number,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  // Classify the request type
  const collectedData = convo.getCollectedData();

  try {
    const requestTypes = await classifyRequestType(collectedData);
    convo.setRequestType(requestTypes.join(','));

    // Generate follow-up questions
    const questions = await generateFollowUpQuestions(collectedData, requestTypes);

    if (questions.length === 0) {
      // No follow-ups needed — go straight to confirming
      await transitionToConfirming(convo, threadTs, say);
      return;
    }

    // Store follow-up questions
    storeFollowUpQuestions(convo, questions);
    convo.setFollowUpIndex(0);
    await convo.save();

    // Transition message
    const typeLabels: Record<string, string> = {
      conference: 'a conference request',
      insider_dinner: 'a Pearl Insider Dinner',
      webinar: 'a webinar request',
      email: 'an email request',
      graphic_design: 'a graphic design request',
      general: 'your request',
    };

    let typeLabel: string;
    if (requestTypes.length > 1) {
      const labels = requestTypes.map((t) => typeLabels[t]?.replace(/^(a|an)\s+/i, '') ?? t);
      typeLabel = 'a ' + labels.join(' + ') + ' request';
    } else {
      typeLabel = typeLabels[requestTypes[0]] ?? 'your request';
    }

    if (fieldsApplied > 1) {
      await say({
        text: `Got most of what I need! Since this looks like ${typeLabel}, I have a few more questions to help the team get started faster.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `Great, I have the basics! Since this looks like ${typeLabel}, I have a few more questions to help the team get started faster.`,
        thread_ts: threadTs,
      });
    }

    // Ask the first follow-up question
    await askFollowUpQuestion(convo, 0, questions, threadTs, say);
  } catch (err) {
    console.error('[intake] Follow-up generation failed, skipping to confirming:', err);
    await transitionToConfirming(convo, threadTs, say);
  }
}

async function handleFollowUpAnswer(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  const questions = getStoredFollowUpQuestions(convo);
  const currentIndex = convo.getFollowUpIndex();

  if (!questions || currentIndex >= questions.length) {
    await transitionToConfirming(convo, threadTs, say);
    return;
  }

  // Check for "submit as-is" / "done"
  if (matchesAny(text, SUBMIT_AS_IS_PATTERNS) || matchesAny(text, DONE_PATTERNS)) {
    await transitionToConfirming(convo, threadTs, say);
    return;
  }

  // Check for "skip"
  if (matchesAny(text, SKIP_PATTERNS)) {
    const nextIndex = currentIndex + 1;
    if (nextIndex >= questions.length) {
      await transitionToConfirming(convo, threadTs, say);
    } else {
      convo.setFollowUpIndex(nextIndex);
      await convo.save();
      await askFollowUpQuestion(convo, nextIndex, questions, threadTs, say);
    }
    return;
  }

  // Check for IDK in follow-up phase
  if (matchesAny(text, IDK_PATTERNS)) {
    const calendarNote = config.marketingLeadCalendarUrl
      ? ` Or <${config.marketingLeadCalendarUrl}|schedule time with marketing> to talk it through.`
      : '';
    await say({
      text: `No worries — you can say *skip* to move on, *discuss* to flag it for a conversation, or give your best guess and the team will refine it.${calendarNote}`,
      thread_ts: threadTs,
    });
    return;
  }

  // Check for "needs discussion" in follow-up phase
  if (matchesAny(text, DISCUSS_PATTERNS)) {
    const currentQuestion = questions[currentIndex];
    flagForDiscussion(convo, currentQuestion.field_key, currentQuestion.question);
    // Store placeholder and advance
    const details = convo.getCollectedData().additional_details;
    details[currentQuestion.field_key] = '_needs discussion_';
    convo.markFieldCollected('additional_details', details);

    const calendarLink = config.marketingLeadCalendarUrl
      ? ` You can also <${config.marketingLeadCalendarUrl}|schedule time with marketing>.`
      : '';
    await say({
      text: `:speech_balloon: Flagged for discussion — we'll cover this when we meet.${calendarLink}`,
      thread_ts: threadTs,
    });

    // Advance to next question
    const nextIndex = currentIndex + 1;
    if (nextIndex >= questions.length) {
      await transitionToConfirming(convo, threadTs, say);
    } else {
      convo.setFollowUpIndex(nextIndex);
      await convo.save();
      await askFollowUpQuestion(convo, nextIndex, questions, threadTs, say);
    }
    return;
  }

  // Interpret the answer — pass upcoming questions so Claude can detect pre-answers
  const currentQuestion = questions[currentIndex];
  const upcomingQuestions = questions.slice(currentIndex + 1);
  try {
    const result = await interpretFollowUpAnswer(text, currentQuestion, convo.getCollectedData(), upcomingQuestions);

    // Store the answer
    const details = convo.getCollectedData().additional_details;
    if (result.value) {
      details[currentQuestion.field_key] = result.value;
    }

    // Store any additional fields
    if (result.additional_fields) {
      for (const [key, value] of Object.entries(result.additional_fields)) {
        details[key] = value;
      }
    }

    convo.markFieldCollected('additional_details', details);
  } catch (err) {
    console.error('[intake] Follow-up interpretation failed:', err);
    // Store raw answer as fallback
    const details = convo.getCollectedData().additional_details;
    details[currentQuestion.field_key] = text;
    convo.markFieldCollected('additional_details', details);
  }

  // Advance to next unanswered question
  const details = convo.getCollectedData().additional_details;
  let nextIndex = currentIndex + 1;
  while (nextIndex < questions.length && details[questions[nextIndex].field_key]) {
    nextIndex++;
  }

  if (nextIndex >= questions.length) {
    await transitionToConfirming(convo, threadTs, say);
  } else {
    convo.setFollowUpIndex(nextIndex);
    await convo.save();
    await askFollowUpQuestion(convo, nextIndex, questions, threadTs, say);
  }
}

// --- Follow-up helpers ---

function storeFollowUpQuestions(convo: ConversationManager, questions: FollowUpQuestion[]): void {
  const details = convo.getCollectedData().additional_details;
  details['__follow_up_questions'] = JSON.stringify(questions);
  convo.markFieldCollected('additional_details', details);
}

function getStoredFollowUpQuestions(convo: ConversationManager): FollowUpQuestion[] | null {
  const details = convo.getCollectedData().additional_details;
  const raw = details['__follow_up_questions'];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FollowUpQuestion[];
  } catch {
    return null;
  }
}

async function askFollowUpQuestion(
  convo: ConversationManager,
  index: number,
  questions: FollowUpQuestion[],
  threadTs: string,
  say: SayFn,
): Promise<void> {
  const question = questions[index];
  const remaining = questions.length - index;

  let progressText = '';
  if (remaining <= 3 && remaining > 1) {
    progressText = `\n_Just ${remaining} more_`;
  } else if (remaining === 1) {
    progressText = `\n_Last one!_`;
  }

  await say({
    text: `${question.question}${progressText}`,
    thread_ts: threadTs,
  });
}

async function transitionToConfirming(
  convo: ConversationManager,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  // Classify the request (quick/full)
  const classification = classifyRequest(convo.getCollectedData());
  convo.setClassification(classification);
  convo.setStatus('confirming');
  convo.setCurrentStep(null);
  convo.save();

  await say({
    text: convo.toSummary(),
    thread_ts: threadTs,
  });
}

// --- Post-submission handling ---

async function handlePostSubmissionMessage(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
  client: WebClient,
): Promise<void> {
  const currentStep = convo.getCurrentStep();

  // Handle sub-flow states
  if (currentStep === 'post_sub:awaiting_info') {
    await handlePostSubInfo(convo, text, threadTs, say, client);
    return;
  }
  if (currentStep === 'post_sub:awaiting_change') {
    await handlePostSubChange(convo, text, threadTs, say, client);
    return;
  }
  if (currentStep === 'post_sub:awaiting_withdraw_confirm') {
    await handlePostSubWithdrawConfirm(convo, text, threadTs, say, client);
    return;
  }

  // Show post-submission action buttons
  await say({
    text: "Looks like you have something to share about this request. What would you like to do?",
    thread_ts: threadTs,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Looks like you have something to share about this request. What would you like to do?',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Additional Information' },
            action_id: 'post_sub_additional',
            value: JSON.stringify({ conversationId: convo.getId() }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Change to Request' },
            action_id: 'post_sub_change',
            value: JSON.stringify({ conversationId: convo.getId() }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Withdraw Request' },
            action_id: 'post_sub_withdraw',
            style: 'danger',
            value: JSON.stringify({ conversationId: convo.getId() }),
          },
        ],
      },
    ],
  });
}

async function handlePostSubInfo(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
  client: WebClient,
): Promise<void> {
  // Store the additional info
  convo.setCurrentStep(null);
  convo.save();

  await say({
    text: "Got it! Your additional information has been forwarded to the marketing team.",
    thread_ts: threadTs,
  });

  // Post in triage thread
  const triageTs = convo.getTriageMessageTs();
  const triageChannelId = convo.getTriageChannelId();
  if (triageTs && triageChannelId) {
    try {
      await client.chat.postMessage({
        channel: triageChannelId,
        text: `The requester has added new information:\n> ${text}`,
        thread_ts: triageTs,
      });
    } catch (err) {
      console.error('[intake] Failed to post to triage thread:', err);
    }
  }

  // Update Monday.com item
  const mondayItemId = convo.getMondayItemId();
  if (mondayItemId) {
    try {
      await addMondayItemUpdate(mondayItemId, `[Additional Information] from requester:\n${text}`);
    } catch (err) {
      console.error('[intake] Failed to add Monday.com update:', err);
    }
  }
}

async function handlePostSubChange(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
  client: WebClient,
): Promise<void> {
  convo.setCurrentStep(null);
  convo.save();

  await say({
    text: "Scope change noted! The marketing team has been notified.",
    thread_ts: threadTs,
  });

  // Post in triage thread
  const triageTs = convo.getTriageMessageTs();
  const triageChannelId = convo.getTriageChannelId();
  if (triageTs && triageChannelId) {
    try {
      await client.chat.postMessage({
        channel: triageChannelId,
        text: `[Scope Change] from requester:\n> ${text}`,
        thread_ts: triageTs,
      });
    } catch (err) {
      console.error('[intake] Failed to post scope change to triage thread:', err);
    }
  }

  // Update Monday.com item
  const mondayItemId = convo.getMondayItemId();
  if (mondayItemId) {
    try {
      await addMondayItemUpdate(mondayItemId, `[Scope Change] from requester:\n${text}`);
    } catch (err) {
      console.error('[intake] Failed to add Monday.com scope change update:', err);
    }
  }
}

async function handlePostSubWithdrawConfirm(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
  client: WebClient,
): Promise<void> {
  if (!matchesAny(text, CONFIRM_PATTERNS)) {
    convo.setCurrentStep(null);
    await convo.save();
    await say({
      text: "Withdrawal cancelled. Your request is still active.",
      thread_ts: threadTs,
    });
    return;
  }

  convo.setStatus('withdrawn');
  convo.setCurrentStep(null);
  convo.save();

  await say({
    text: "Your request has been withdrawn.",
    thread_ts: threadTs,
  });

  // Update Monday.com
  const mondayItemId = convo.getMondayItemId();
  if (mondayItemId) {
    const classification = convo.getClassification() === 'undetermined' ? 'quick' : convo.getClassification() as 'quick' | 'full';
    const mondayBoardId = classification === 'quick' ? config.mondayQuickBoardId : config.mondayFullBoardId;
    try {
      await updateMondayItemStatus(mondayItemId, mondayBoardId, 'Withdrawn');
    } catch (err) {
      console.error('[intake] Failed to update Monday.com to Withdrawn:', err);
    }
    try {
      await addMondayItemUpdate(mondayItemId, 'Request withdrawn by requester.');
    } catch (err) {
      console.error('[intake] Failed to add Monday.com withdrawal update:', err);
    }
  }

  // Update triage panel
  const triageTs = convo.getTriageMessageTs();
  const triageChannelId = convo.getTriageChannelId();
  if (triageTs && triageChannelId) {
    try {
      await client.chat.postMessage({
        channel: triageChannelId,
        text: 'Request withdrawn by requester.',
        thread_ts: triageTs,
      });
    } catch (err) {
      console.error('[intake] Failed to post withdrawal to triage thread:', err);
    }
  }
}

// --- Action handler registration ---

export function registerPostSubmissionActions(app: App): void {
  app.action('post_sub_additional', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId } = JSON.parse(action.value) as { conversationId: number };
    const convo = await loadConversationById(conversationId);
    if (!convo) return;

    convo.setCurrentStep('post_sub:awaiting_info');
    await convo.save();

    try {
      await client.chat.postMessage({
        channel: convo.getChannelId(),
        text: "What additional information would you like to add?",
        thread_ts: convo.getThreadTs(),
      });
    } catch (err) {
      console.error('[intake] Failed to prompt for additional info:', err);
    }
  });

  app.action('post_sub_change', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId } = JSON.parse(action.value) as { conversationId: number };
    const convo = await loadConversationById(conversationId);
    if (!convo) return;

    convo.setCurrentStep('post_sub:awaiting_change');
    await convo.save();

    try {
      await client.chat.postMessage({
        channel: convo.getChannelId(),
        text: "What would you like to change?",
        thread_ts: convo.getThreadTs(),
      });
    } catch (err) {
      console.error('[intake] Failed to prompt for change:', err);
    }
  });

  app.action('post_sub_withdraw', async ({ ack, body, client }) => {
    await ack();
    if (body.type !== 'block_actions' || !body.actions?.[0]) return;
    const action = body.actions[0];
    if (!('value' in action) || !action.value) return;

    const { conversationId } = JSON.parse(action.value) as { conversationId: number };
    const convo = await loadConversationById(conversationId);
    if (!convo) return;

    convo.setCurrentStep('post_sub:awaiting_withdraw_confirm');
    await convo.save();

    try {
      await client.chat.postMessage({
        channel: convo.getChannelId(),
        text: "Are you sure you want to withdraw this request? Reply *yes* to confirm.",
        thread_ts: convo.getThreadTs(),
      });
    } catch (err) {
      console.error('[intake] Failed to prompt for withdraw confirmation:', err);
    }
  });
}

// --- Helpers ---

async function loadConversationById(conversationId: number): Promise<ConversationManager | null> {
  const row = await getConversationById(conversationId);
  if (!row) {
    console.error('[intake] Conversation not found:', conversationId);
    return null;
  }
  const convo = await ConversationManager.load(row.user_id, row.thread_ts);
  if (!convo) {
    console.error('[intake] Could not load ConversationManager for:', conversationId);
    return null;
  }
  return convo;
}

async function askNextQuestion(
  convo: ConversationManager,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  const next = convo.getNextQuestion();
  if (!next) return;

  convo.save();

  await say({
    text: `${next.question}\n_${next.example}_`,
    thread_ts: threadTs,
  });
}

/**
 * Apply extracted fields from Claude to the conversation.
 * Returns the number of fields that were newly applied.
 */
function applyExtractedFields(
  convo: ConversationManager,
  extracted: ExtractedFields,
): number {
  let count = 0;
  const current = convo.getCollectedData();

  const fieldKeys: (keyof ExtractedFields)[] = [
    'requester_name',
    'requester_department',
    'target',
    'context_background',
    'desired_outcomes',
    'deliverables',
    'due_date',
    'due_date_parsed',
    'approvals',
    'constraints',
    'supporting_links',
  ];

  for (const field of fieldKeys) {
    const newValue = extracted[field];
    if (newValue === null || newValue === undefined) continue;
    if (Array.isArray(newValue) && newValue.length === 0) continue;

    // Check if this field is already populated with the same value
    const currentValue = current[field as keyof CollectedData];
    if (Array.isArray(currentValue) && Array.isArray(newValue)) {
      if (currentValue.length > 0 && JSON.stringify(currentValue) === JSON.stringify(newValue)) continue;
    } else if (currentValue !== null && currentValue !== '' && currentValue === newValue) {
      continue;
    }

    convo.markFieldCollected(field as keyof CollectedData, newValue as string | string[]);
    count++;
  }

  return count;
}

/**
 * Flag a field as needing discussion. Stores in additional_details under __needs_discussion.
 */
function flagForDiscussion(convo: ConversationManager, fieldKey: string, label: string): void {
  const details = convo.getCollectedData().additional_details;
  let flags: { field: string; label: string }[] = [];
  try {
    flags = JSON.parse(details['__needs_discussion'] ?? '[]');
  } catch { /* ignore */ }
  // Avoid duplicates
  if (!flags.some((f) => f.field === fieldKey)) {
    flags.push({ field: fieldKey, label });
  }
  details['__needs_discussion'] = JSON.stringify(flags);
  convo.markFieldCollected('additional_details', details);
}

/** Format a snake_case field key as a readable label. */
function formatFieldLabel(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
