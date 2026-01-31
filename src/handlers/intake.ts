import type { SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager, type CollectedData } from '../lib/conversation';
import { interpretMessage, classifyRequest, type ExtractedFields } from '../lib/claude';
import { sendApprovalRequest } from './approval';
import { getActiveConversationForUser, cancelConversation } from '../lib/db';

// --- Confirmation keywords ---

const CONFIRM_PATTERNS = [/^y(es)?$/i, /^confirm$/i, /^submit$/i, /^looks?\s*good$/i, /^correct$/i, /^that'?s?\s*right$/i, /^yep$/i, /^yeah$/i];
const CANCEL_PATTERNS = [/^cancel$/i, /^nevermind$/i, /^never\s*mind$/i, /^forget\s*it$/i, /^nvm$/i];
const RESET_PATTERNS = [/^start\s*over$/i, /^reset$/i, /^restart$/i, /^from\s*scratch$/i];
const CONTINUE_PATTERNS = [/^continue$/i, /^resume$/i, /^pick\s*up$/i, /^keep\s*going$/i];
const CONTINUE_THERE_PATTERNS = [/^continue\s*there$/i, /^go\s*there$/i, /^that\s*one$/i, /^use\s*that$/i];
const START_FRESH_PATTERNS = [/^start\s*fresh$/i, /^new\s*one$/i, /^start\s*(a\s*)?new$/i, /^fresh$/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  const trimmed = text.trim();
  return patterns.some((p) => p.test(trimmed));
}

/**
 * Tracks users who were asked about a duplicate active conversation.
 * Maps userId → the existing conversation's thread_ts, channel_id, and the thread where the prompt was shown.
 */
const pendingDuplicateChecks = new Map<string, { existingThreadTs: string; existingChannelId: string; existingConvoId: number; promptThreadTs: string }>();

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
  text: string;
  say: SayFn;
  client: WebClient;
}): Promise<void> {
  const { userId, userName, channelId, threadTs, text, say, client } = opts;

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
  const { userId, userName, channelId, text, say, client } = opts;
  let threadTs = opts.threadTs;

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
      cancelConversation(pendingDup.existingConvoId);
    } else {
      pendingDuplicateChecks.delete(userId);
      // Unrecognized response — treat as "start fresh" since user is clearly trying to interact
      cancelConversation(pendingDup.existingConvoId);
    }
  }

  // Load or create conversation
  let convo = ConversationManager.load(userId, threadTs);
  console.log(`[intake] load(${userId}, ${threadTs}) → ${convo ? 'found existing' : 'no conversation'}`);

  // If the conversation was found via userId fallback, use its stored threadTs for replies
  if (convo && convo.getThreadTs() !== threadTs) {
    console.log(`[intake] Using conversation's stored threadTs ${convo.getThreadTs()} instead of ${threadTs}`);
    threadTs = convo.getThreadTs();
  }

  if (!convo) {
    // Check for active conversation in another thread
    const existingConvo = getActiveConversationForUser(userId, threadTs);
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
    convo.save();

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

  // --- Handle completed/cancelled conversations ---
  if (status === 'complete') {
    await say({
      text: "This request has already been submitted. If you need something new, just start a new message thread with me!",
      thread_ts: threadTs,
    });
    return;
  }

  if (status === 'cancelled') {
    await say({
      text: "This conversation was cancelled. Start a new thread if you'd like to submit a request!",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Handle pending_approval state ---
  if (status === 'pending_approval') {
    await say({
      text: "Your request has been submitted and is waiting for marketing team review. I'll let you know once it's been reviewed!",
      thread_ts: threadTs,
    });
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
    convo.save();
    await say({
      text: "No problem — request cancelled. If you change your mind, just start a new conversation!",
      thread_ts: threadTs,
    });
    return;
  }

  // Check for start over
  if (matchesAny(text, RESET_PATTERNS)) {
    convo.reset();
    convo.save();
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

    // Set status to pending_approval (Monday.com item deferred until "In Progress")
    convo.setStatus('pending_approval');
    convo.save();

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
      });
    } catch (err) {
      console.error('[intake] Failed to send approval request:', err);
    }

    return;
  }

  // User is describing changes — re-interpret and update
  try {
    const extracted = await interpretMessage(text, convo.getCollectedData());
    applyExtractedFields(convo, extracted);
    convo.save();

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
    convo.save();
    await say({
      text: "No problem — request cancelled. If you change your mind, just start a new conversation!",
      thread_ts: threadTs,
    });
    return;
  }

  // Check for start over
  if (matchesAny(text, RESET_PATTERNS)) {
    convo.reset();
    convo.save();
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
    await askNextQuestion(convo, threadTs, say);
    return;
  }

  // Interpret the message via Claude
  console.log(`[intake] Calling Claude to interpret: "${text.substring(0, 80)}" for convo threadTs=${convo.getThreadTs()}, replyThreadTs=${threadTs}`);
  try {
    const extracted = await interpretMessage(text, convo.getCollectedData(), undefined, convo.getCurrentStep());
    console.log(`[intake] Claude response: confidence=${extracted.confidence}, department=${extracted.requester_department}`);
    const fieldsApplied = applyExtractedFields(convo, extracted);

    if (fieldsApplied === 0 && extracted.confidence < 0.3) {
      await say({
        text: "I didn't quite catch that. Could you rephrase?",
        thread_ts: threadTs,
      });
      // Re-ask the current question
      await askNextQuestion(convo, threadTs, say);
      return;
    }

    // Check if all required fields are now collected
    if (convo.isComplete()) {
      // Classify the request
      const classification = classifyRequest(convo.getCollectedData());
      convo.setClassification(classification);
      convo.setStatus('confirming');
      convo.save();

      // Show how many fields we got if user was bundled
      if (fieldsApplied > 1) {
        await say({
          text: "Got most of what I need! Let me confirm the details:",
          thread_ts: threadTs,
        });
      }

      await say({
        text: convo.toSummary(),
        thread_ts: threadTs,
      });
    } else {
      convo.save();

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

// --- Helpers ---

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

  const fieldKeys: (keyof CollectedData)[] = [
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
    const currentValue = current[field];
    if (Array.isArray(currentValue) && Array.isArray(newValue)) {
      if (currentValue.length > 0 && JSON.stringify(currentValue) === JSON.stringify(newValue)) continue;
    } else if (currentValue !== null && currentValue !== '' && currentValue === newValue) {
      continue;
    }

    convo.markFieldCollected(field, newValue as string | string[]);
    count++;
  }

  return count;
}
