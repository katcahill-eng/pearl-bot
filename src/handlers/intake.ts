import type { App, SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager, generateProjectName, type CollectedData } from '../lib/conversation';
import { interpretMessage, classifyRequest, classifyRequestType, generateFollowUpQuestions, interpretFollowUpAnswer, type ExtractedFields, type FollowUpQuestion } from '../lib/claude';
import { generateFieldGuidance } from '../lib/guidance';
import { generateProductionTimeline } from '../lib/timeline';
import { sendApprovalRequest } from './approval';
import { getActiveConversationForUser, getConversationById, cancelConversation, updateTriageInfo, isMessageProcessed, hasConversationInThread } from '../lib/db';
import { createMondayItemForReview } from '../lib/workflow';
import { addMondayItemUpdate, updateMondayItemStatus, buildMondayUrl, searchItems } from '../lib/monday';
import { searchProjects } from '../lib/db';

// --- Confirmation keywords ---

const CONFIRM_PATTERNS = [
  /^y(es)?(\s|!|$)/i, /^confirm/i, /^submit/i, /^looks?\s*good/i, /^correct/i,
  /^that'?s?\s*right/i, /^yep(\s|!|$)/i, /^yeah/i, /^yup(\s|!|$)/i, /^ok(ay)?/i,
  /^sure/i, /^sounds?\s*good/i, /^go\s*ahead/i, /^perfect/i, /^all\s*good/i,
  /^go\s*for\s*it/i, /^alright/i, /^right(\s|!|$)/i, /^absolutely/i, /^for\s*sure/i,
  /^(yes|yeah|yep|sure|ok)\s*(please|thanks|submit|do\s*it|go)/i,
  /^(lgtm|ship\s*it)/i, /^approved/i, /^send\s*it/i,
];
const CANCEL_PATTERNS = [
  /^cancel$/i, /^nevermind$/i, /^never\s*mind/i, /^forget\s*(about\s*)?it$/i,
  /^nvm$/i, /^stop$/i, /^abort$/i, /^quit$/i, /^scratch\s*that$/i,
  /^no\s*thanks/i,
];
const RESET_PATTERNS = [/^start\s*over$/i, /^reset$/i, /^restart$/i, /^from\s*(the\s*)?scratch$/i, /^redo$/i, /^from\s*the\s*beginning$/i];
const CONTINUE_PATTERNS = [/^continue$/i, /^resume$/i, /^pick\s*up$/i, /^keep\s*going$/i, /^go\s*on$/i];
const CONTINUE_THERE_PATTERNS = [
  /^continue\s*there$/i, /^go\s*(back\s*)?there$/i, /^that\s*(one|thread|conversation)$/i,
  /^use\s*that(\s*one)?$/i, /^(the\s*)?other\s*(one|thread)$/i, /^(i'?ll?\s*)?(go|continue)\s*there$/i,
  /^back\s*there$/i, /^(yeah?|ok|yes)\s*(go|continue)\s*there$/i,
];
const START_FRESH_PATTERNS = [
  /^start\s*fresh/i, /^new\s*(one|request)$/i, /^start\s*(a\s*)?new/i,
  /^fresh$/i, /^(start|stay)\s*here$/i,
  /^new\s*here$/i, /^brand\s*new$/i,
  /^star\w?\s+fresh/i, /\bfresh\s+here\b/i,
];
const SUBMIT_AS_IS_PATTERNS = [/^submit\s*as[\s-]*is$/i, /^just\s*submit$/i, /^submit\s*now$/i];
const SKIP_PATTERNS = [/^skip$/i, /^skip\s*(this|it|that)$/i, /^pass$/i, /^next$/i, /^move\s*on$/i, /^n\/?a$/i];
const DONE_PATTERNS = [/^done$/i, /^that'?s?\s*(all|it|everything)/i, /^no\s*more/i, /^nothing\s*(else)?$/i, /^all\s*set$/i, /^we'?re?\s*(done|all\s*set)/i];
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
const NUDGE_PATTERNS = [
  /^h(ello|i|ey|owdy)\b/i, /^yo\b/i, /^sup\b/i, /^what['\u2019]?s\s*up/i,
  /^are\s*you\s*(there|still\s*there|around|listening|alive)/i,
  /^anyone\s*(there|home|around)/i, /^you\s*(there|still\s*there|around)/i,
  /^still\s*(there|here|around|working)/i, /^ping/i, /^nudge/i, /^poke/i,
  /^come\s*back/i, /^wake\s*up/i, /^bot\??$/i, /^help\s*me$/i,
  /^\?\??$/i,
];

// --- Command-like message filter for recovery paths ---
// Short messages that are commands/greetings/confirmations rather than actual intake content.
// Used to filter thread history before sending to Claude for field extraction during recovery,
// so Claude doesn't hallucinate fields from "yes", "here", "skip", etc.

const COMMAND_LIKE_PATTERNS = [
  ...CONFIRM_PATTERNS, ...CANCEL_PATTERNS, ...RESET_PATTERNS,
  ...CONTINUE_PATTERNS, ...CONTINUE_THERE_PATTERNS, ...START_FRESH_PATTERNS,
  ...SUBMIT_AS_IS_PATTERNS, ...SKIP_PATTERNS, ...DONE_PATTERNS,
  ...IDK_PATTERNS, ...DISCUSS_PATTERNS, ...NUDGE_PATTERNS,
];

function isCommandLikeMessage(text: string): boolean {
  const trimmed = text.trim();
  // Very short messages (<=3 words) that match any command pattern
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 4 && COMMAND_LIKE_PATTERNS.some((p) => p.test(trimmed))) {
    return true;
  }
  return false;
}

// --- Project match search ---

interface ProjectMatch {
  name: string;
  mondayUrl?: string;
  source: 'db' | 'monday';
}

async function searchForProjectMatches(keywords: string[]): Promise<ProjectMatch[]> {
  const seen = new Set<string>();
  const matches: ProjectMatch[] = [];

  // Search all keywords in parallel across both DB and Monday.com
  const searchPromises = keywords.flatMap((keyword) => [
    searchProjects(keyword).then((results) =>
      results.map((r) => ({ name: r.name, mondayUrl: r.monday_url ?? undefined, source: 'db' as const }))
    ),
    searchItems(keyword).then((results) =>
      results.map((r) => ({ name: r.name, mondayUrl: r.boardUrl, source: 'monday' as const }))
    ),
  ]);

  const allResults = await Promise.all(searchPromises);

  for (const resultSet of allResults) {
    for (const match of resultSet) {
      const key = match.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        matches.push(match);
      }
    }
  }

  return matches;
}

/** Detect mentions of existing content/drafts in user messages. */
function mentionsExistingContent(text: string): boolean {
  const lower = text.toLowerCase();
  const patterns = [
    /existing\s+(content|draft|deck|copy|doc|document|slides?|one[- ]?pager|asset)/i,
    /already\s+(have|started|wrote|created|drafted|built)/i,
    /draft\s+(is|that|we|i)/i,
    /have\s+a\s+(draft|deck|doc|document|version|start)/i,
    /started\s+(on|writing|creating|drafting|working)/i,
    /rough\s+(draft|version|copy|outline)/i,
    /needs?\s+(refreshing|updating|refresh|update|polish)/i,
    /work[- ]?in[- ]?progress/i,
    /wip/i,
  ];
  return patterns.some((p) => p.test(lower));
}

/** Fields asked during the gathering phase — used for raw-text fallback when Claude returns 0 fields. */
const GATHERING_FIELDS: (keyof CollectedData)[] = [
  'requester_name', 'requester_department', 'target', 'context_background',
  'desired_outcomes', 'deliverables', 'due_date',
];

const CONVERSATIONAL_PREFIX = /^(let['']?s\s+|let\s+us\s+|i['']?d\s+like\s+to\s+|i\s+want\s+to\s+|can\s+we\s+|please\s+|i\s+want\s+|we\s+should\s+|we\s+can\s+)/i;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  const trimmed = text.trim();
  if (patterns.some((p) => p.test(trimmed))) return true;
  // Also try after stripping common conversational prefixes like "let's", "I want to", etc.
  const stripped = trimmed.replace(CONVERSATIONAL_PREFIX, '').trim();
  if (stripped !== trimmed && patterns.some((p) => p.test(stripped))) return true;
  return false;
}

/**
 * Deduplication: uses a DB-backed table (message_dedup) to prevent
 * double-processing across containers during rolling deploys,
 * and when both app_mention and message events fire for the same message.
 */

// --- Recovery from lost conversations ---

/**
 * Attempt to recover a lost conversation by reading the Slack thread history.
 * This handles the case where a deploy or crash killed the container mid-conversation,
 * losing the DB record. We read all user messages from the thread, extract fields via Claude,
 * and recreate the conversation — then continue from the next unanswered question.
 *
 * Returns true if recovery happened, false if this thread has no prior bot interaction.
 */
export async function recoverConversationFromHistory(opts: {
  userId: string;
  channelId: string;
  threadTs: string;
  say: SayFn;
  client: WebClient;
}): Promise<boolean> {
  const { userId, channelId, threadTs, say, client } = opts;

  // 0. Skip recovery for very recent threads (< 30s) — these are likely timing issues,
  // not lost conversations. The botWasActive path handles the deploy case with history extraction.
  const threadAgeSeconds = Date.now() / 1000 - parseFloat(threadTs);
  if (threadAgeSeconds < 30) {
    console.log(`[intake] Recovery: thread is only ${threadAgeSeconds.toFixed(0)}s old, skipping recovery`);
    return false;
  }

  // 1. Fetch thread history from Slack
  let messages: any[];
  try {
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });
    messages = (replies.messages ?? []) as any[];
  } catch (err) {
    console.error('[intake] Failed to fetch thread history for recovery:', err);
    return false;
  }

  // 2. Check if the bot previously sent messages in this thread
  const hasBotMessages = messages.some((m: any) => m.bot_id || m.subtype === 'bot_message');
  if (!hasBotMessages) {
    return false;
  }

  console.log(`[intake] Recovery: found bot messages in thread ${threadTs} (${messages.length} total messages)`);

  // 3. Extract user messages (strip @mentions, chronological order)
  //    Filter out command-like messages (e.g. "here", "start fresh", "yes", "skip")
  //    that aren't actual intake content — they confuse Claude's extraction.
  const userTexts = messages
    .filter((m: any) => !m.bot_id && !m.subtype && m.user === userId)
    .map((m: any) => (m.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim())
    .filter((t: string) => t.length > 0)
    .filter((t: string) => !isCommandLikeMessage(t));

  if (userTexts.length === 0) {
    console.log('[intake] Recovery: no user messages found in thread');
    return false;
  }

  // 4. Look up user profile for name and department
  let realName = 'Unknown';
  let department: string | null = null;
  try {
    const userInfo = await client.users.info({ user: userId });
    const profile = userInfo.user?.profile;
    realName = profile?.real_name ?? userInfo.user?.real_name ?? userInfo.user?.name ?? 'Unknown';
    const jobTitle = profile?.title ?? null;

    if (jobTitle) {
      const titleLower = jobTitle.toLowerCase();
      if (titleLower.includes('marketing') || titleLower.includes('marcom')) department = 'Marketing';
      else if (titleLower.includes('business development') || titleLower.includes(' bd') || titleLower.startsWith('bd ')) department = 'Business Development';
      else if (titleLower.includes('customer') || titleLower.includes(' cx') || titleLower.startsWith('cx ')) department = 'Customer Experience';
      else if (titleLower.includes('product')) department = 'Product';
      else if (titleLower.includes('engineering') || titleLower.includes('developer') || titleLower.includes('engineer')) department = 'Engineering';
      else if (titleLower.includes('sales')) department = 'Sales';
      else if (titleLower.includes('finance') || titleLower.includes('accounting')) department = 'Finance';
      else if (titleLower.includes('hr') || titleLower.includes('people') || titleLower.includes('human resources')) department = 'People/HR';
      else if (titleLower.includes('executive') || titleLower.includes('ceo') || titleLower.includes('coo') || titleLower.includes('cfo')) department = 'Executive';
    }
  } catch (err) {
    console.error('[intake] Failed to look up user profile during recovery:', err);
  }

  // 5. Combine all user messages and extract fields via Claude
  const combinedText = userTexts.join('\n\n');
  console.log(`[intake] Recovery: extracting fields from ${userTexts.length} message(s): "${combinedText.substring(0, 120)}"`);

  let extracted: ExtractedFields;
  try {
    extracted = await interpretMessage(combinedText, {});
  } catch (err) {
    console.error('[intake] Recovery: Claude extraction failed:', err);
    return false;
  }

  // 6. Create conversation with pre-filled fields
  const convo = new ConversationManager({
    userId,
    userName: realName,
    channelId,
    threadTs,
  });

  if (realName !== 'Unknown') {
    convo.markFieldCollected('requester_name', realName);
  }
  if (department) {
    convo.markFieldCollected('requester_department', department);
  }

  applyExtractedFields(convo, extracted);
  await convo.save();

  const collectedCount = Object.entries(convo.getCollectedData())
    .filter(([k, v]) => k !== 'additional_details' && k !== 'request_type' && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
    .length;
  console.log(`[intake] Recovery: reconstructed conversation with ${collectedCount} field(s), complete=${convo.isComplete()}`);

  // 7. Send recovery message and continue
  await say({
    text: "Sorry about that — I had a brief interruption, but I've caught up on everything you shared. Let me pick up where we left off.",
    thread_ts: threadTs,
  });

  // 8. Continue from the right place
  if (convo.isComplete()) {
    await enterFollowUpPhase(convo, 1, threadTs, say);
  } else {
    await askNextQuestion(convo, threadTs, say);
  }

  return true;
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

  // Deduplicate: skip if this exact message was already processed by another container
  // (happens during rolling deploys and when both app_mention and message events fire)
  console.log(`[intake] handleIntakeMessage called: messageTs=${messageTs}, threadTs=${threadTs}, text="${text.substring(0, 60)}"`);
  if (await isMessageProcessed(messageTs)) {
    console.log(`[intake] Skipping duplicate message ${messageTs} (already processed by another container)`);
    return;
  }
  console.log(`[intake] Message ${messageTs} claimed (not a duplicate), proceeding`);

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

  // Load or create conversation
  let convo = await ConversationManager.load(userId, threadTs);
  console.log(`[intake] load(${userId}, ${threadTs}) → ${convo ? `found existing (status=${convo.getStatus()}, step=${convo.getCurrentStep()}, id=${convo.getId()})` : 'no conversation'}`);

  // If the conversation in this thread is terminal, treat it as "no conversation" — user is starting fresh
  if (convo && (convo.getStatus() === 'complete' || convo.getStatus() === 'cancelled' || convo.getStatus() === 'withdrawn')) {
    console.log(`[intake] Conversation in thread ${threadTs} is ${convo.getStatus()}, treating as new`);
    convo = undefined;
  }

  // Handle pending duplicate-check responses (DB-persisted, survives restarts)
  console.log(`[intake] dup_check gate: convo=${!!convo}, step="${convo?.getCurrentStep()}", startsWith_dup_check=${convo?.getCurrentStep()?.startsWith('dup_check:')}, text="${text}"`);
  if (convo && convo.getCurrentStep()?.startsWith('dup_check:')) {
    console.log(`[intake] → ENTERING handleDuplicateCheckResponse for text="${text}"`);
    await handleDuplicateCheckResponse(convo, text, threadTs, say);
    return;
  }

  if (!convo) {
    // Look up the user's profile from Slack — name, title, department
    let realName = 'Unknown';
    let jobTitle: string | null = null;
    let department: string | null = null;
    try {
      const userInfo = await client.users.info({ user: userId });
      const profile = userInfo.user?.profile;
      realName = profile?.real_name ?? userInfo.user?.real_name ?? userInfo.user?.name ?? 'Unknown';
      jobTitle = profile?.title ?? null;

      // Log profile to help debug what fields are available
      console.log(`[intake] Slack profile for ${userId}:`, JSON.stringify({
        real_name: profile?.real_name,
        display_name: profile?.display_name,
        title: profile?.title,
      }));

      // Try to infer department from job title if it contains common patterns
      if (jobTitle) {
        const titleLower = jobTitle.toLowerCase();
        if (titleLower.includes('marketing') || titleLower.includes('marcom')) {
          department = 'Marketing';
        } else if (titleLower.includes('business development') || titleLower.includes(' bd') || titleLower.startsWith('bd ')) {
          department = 'Business Development';
        } else if (titleLower.includes('customer') || titleLower.includes(' cx') || titleLower.startsWith('cx ')) {
          department = 'Customer Experience';
        } else if (titleLower.includes('product')) {
          department = 'Product';
        } else if (titleLower.includes('engineering') || titleLower.includes('developer') || titleLower.includes('engineer')) {
          department = 'Engineering';
        } else if (titleLower.includes('sales')) {
          department = 'Sales';
        } else if (titleLower.includes('finance') || titleLower.includes('accounting')) {
          department = 'Finance';
        } else if (titleLower.includes('hr') || titleLower.includes('people') || titleLower.includes('human resources')) {
          department = 'People/HR';
        } else if (titleLower.includes('executive') || titleLower.includes('ceo') || titleLower.includes('coo') || titleLower.includes('cfo')) {
          department = 'Executive';
        }
      }

      console.log(`[intake] Resolved user: name="${realName}", title="${jobTitle}", inferred department="${department}"`);
    } catch (err) {
      console.error('[intake] Failed to look up user profile for', userId, '— bot may need users:read scope. Error:', err);
    }

    // Check if the bot was already active in this thread (conversation lost during deploy)
    // If so, recreate silently and process the message — no welcome, no dup-check
    // Uses two signals: (1) bot messages in Slack thread, (2) any DB conversation for this thread
    let botWasActive = false;
    try {
      const replies = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 50,
      });
      botWasActive = replies.messages?.some((m) =>
        (('bot_id' in m && m.bot_id) || ('subtype' in m && m.subtype === 'bot_message')) && m.ts !== threadTs
      ) ?? false;
    } catch (err) {
      console.error('[intake] Failed to check thread history via Slack API:', err);
    }
    // Fallback: check DB for any prior conversation in this thread (even cancelled/completed)
    if (!botWasActive) {
      try {
        botWasActive = await hasConversationInThread(threadTs);
        if (botWasActive) console.log(`[intake] DB shows prior conversation in thread ${threadTs}`);
      } catch (err) {
        console.error('[intake] Failed to check DB for prior conversation:', err);
      }
    }

    if (botWasActive) {
      console.log(`[intake] Bot was already active in thread ${threadTs} — recreating conversation from thread history`);
      // Extract fields from all prior user messages in the thread
      convo = new ConversationManager({ userId, userName: realName, channelId, threadTs });
      if (realName !== 'Unknown') convo.markFieldCollected('requester_name', realName);
      if (department) convo.markFieldCollected('requester_department', department);
      try {
        const historyReplies = await client.conversations.replies({
          channel: channelId, ts: threadTs, limit: 200,
        });
        const userTexts = (historyReplies.messages ?? [])
          .filter((m: any) => !m.bot_id && !('subtype' in m && m.subtype) && m.user === userId)
          .map((m: any) => (m.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim())
          .filter((t: string) => t.length > 0)
          .filter((t: string) => !isCommandLikeMessage(t));
        if (userTexts.length > 0) {
          // Don't include the current message — it will be processed normally below
          const priorTexts = userTexts.slice(0, -1);
          if (priorTexts.length > 0) {
            const combined = priorTexts.join('\n\n');
            console.log(`[intake] Extracting fields from ${priorTexts.length} prior message(s)`);
            const historyExtracted = await interpretMessage(combined, {});
            applyExtractedFields(convo, historyExtracted);
          }
        }
      } catch (err) {
        console.error('[intake] Failed to extract fields from thread history:', err);
      }
      await convo.save();
      // Fall through to status handling below — process the current message normally
    } else {
      // Check for active conversation in another thread
      const existingConvo = await getActiveConversationForUser(userId, threadTs);
      console.log(`[intake] activeConversationForUser → ${existingConvo ? `found id=${existingConvo.id} thread=${existingConvo.thread_ts}` : 'none'}`);
      if (existingConvo) {
        // Create a placeholder conversation to persist the duplicate check (survives restarts)
        const dupConvo = new ConversationManager({
          userId,
          userName: realName,
          channelId,
          threadTs,
        });
        if (realName !== 'Unknown') {
          dupConvo.markFieldCollected('requester_name', realName);
        }
        if (department) {
          dupConvo.markFieldCollected('requester_department', department);
        }
        dupConvo.setCurrentStep(`dup_check:${existingConvo.id}`);
        dupConvo.markFieldCollected('additional_details', {
          '__dup_existing_channel': existingConvo.channel_id,
          '__dup_existing_thread': existingConvo.thread_ts,
        } as unknown as Record<string, string>);
        console.log(`[intake] SAVING dup_check conversation: threadTs=${threadTs}, step=dup_check:${existingConvo.id}`);
        const savedId = await dupConvo.save();
        console.log(`[intake] SAVED dup_check conversation: id=${savedId}, threadTs=${threadTs}`);
        await say({
          text: "Welcome back! It looks like you have an open request in another thread — would you like to *continue there* or *start fresh* here?",
          thread_ts: threadTs,
        });
        console.log(`[intake] SENT dup_check prompt in thread ${threadTs}`);
        return;
      }

      convo = new ConversationManager({
        userId,
        userName: realName,
        channelId,
        threadTs,
      });

      // Auto-fill fields from Slack profile
      const nameFromSlack = realName !== 'Unknown';
      if (nameFromSlack) {
        convo.markFieldCollected('requester_name', realName);
      }
      if (department) {
        convo.markFieldCollected('requester_department', department);
      }
      await convo.save();

      // Send a warm welcome before processing their message (randomized)
      console.log(`[intake] Sending welcome message in thread ${threadTs}`);
      const welcomeMessages = [
        "Hey! Thanks for reaching out to marketing. I'd love to help you with this. I'm going to ask you a few quick questions so I can get your request to the right people.\n_If I ever pause or fail to reply, just say hello? and I'll pick back up._",
        "Hi! Thanks for reaching out to the marketing team. To get things moving, I'll walk you through a few quick questions about your request.\n_If I ever go quiet, just say hello? and I'll jump back in._",
        "Hey there! Glad you reached out to marketing. I'll just need to ask you a few questions to make sure we have everything we need to get started.\n_If I ever drop off, just say hello? and I'll pick up where we left off._",
        "Hi there! Thanks for coming to us. Let me ask you a few quick questions so we can get your request set up and into the right hands.\n_If I ever pause, just say hello? to get me back on track._",
      ];
      await say({
        text: welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)],
        thread_ts: threadTs,
      });

      // If we pre-filled name/department from Slack, confirm with the user before moving on
      if (nameFromSlack || department) {
        const namePart = nameFromSlack ? realName : null;
        const deptPart = department ?? null;
        let confirmMsg: string;
        if (namePart && deptPart) {
          confirmMsg = `I have you down as *${namePart}* from *${deptPart}*. If that's not right, just let me know — otherwise, let's jump in!`;
        } else if (namePart) {
          confirmMsg = `I have you down as *${namePart}*. If that's not right, just let me know — otherwise, let's jump in!`;
        } else {
          confirmMsg = `I have you down as part of *${deptPart}*. If that's not right, just let me know — otherwise, let's jump in!`;
        }
        await say({ text: confirmMsg, thread_ts: threadTs });
      }

      // Ask the first unanswered question and return — don't try to interpret the initial message as an answer
      await askNextQuestion(convo, threadTs, say);
      return;
    }
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

  // Check for start over / start fresh
  if (matchesAny(text, RESET_PATTERNS) || matchesAny(text, START_FRESH_PATTERNS)) {
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
    // Use the collected requester_name (which the user may have corrected), not the initial Slack lookup
    const requesterName = collectedData.requester_name ?? convo.getUserName();

    // Create Monday.com item at submission time
    let mondayItemId: string | null = null;
    let mondayUrl: string | null = null;
    try {
      const mondayResult = await createMondayItemForReview({
        collectedData,
        classification: effectiveClassification,
        requesterName,
        channelId: convo.getChannelId(),
        threadTs: convo.getThreadTs(),
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
    const projectName = generateProjectName(collectedData);

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

  // --- Nudge/greeting detection — resume the conversation ---
  if (matchesAny(text, NUDGE_PATTERNS)) {
    await say({
      text: "Still here! Here's what I have so far:",
      thread_ts: threadTs,
    });
    await say({
      text: convo.toSummary(),
      thread_ts: threadTs,
    });
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
    const changed = applyExtractedFields(convo, extracted, true); // allowOverwrite — user is correcting fields
    await convo.save();

    if (changed > 0) {
      await say({
        text: "Got it, I've updated the request. Here's the revised summary:",
        thread_ts: threadTs,
      });
      await say({
        text: convo.toSummary(),
        thread_ts: threadTs,
      });
    } else {
      // No fields were changed — user likely said "no" or something non-descriptive
      await say({
        text: "What would you like to change? Just describe the update (e.g., \"change the due date to March 15\") — or reply *yes* to submit, *start over* to redo, or *cancel* to scrap it.",
        thread_ts: threadTs,
      });
    }
  } catch (error) {
    console.error('[intake] Claude interpretation error during confirmation:', error);
    const formFallback = config.intakeFormUrl ? `\nOr you can fill out the form instead: ${config.intakeFormUrl}` : '';
    await say({
      text: `I didn't quite catch that. You can reply *yes* to submit, describe what to change, say *start over*, or *cancel*.${formFallback}`,
      thread_ts: threadTs,
    });
  }
}

async function handleDuplicateCheckResponse(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  console.log(`[intake] handleDuplicateCheckResponse called with text="${text}", threadTs=${threadTs}`);
  const step = convo.getCurrentStep()!;
  const existingConvoId = parseInt(step.split(':')[1], 10);
  const details = convo.getCollectedData().additional_details;
  const existingChannelId = details['__dup_existing_channel'] ?? '';
  const existingThreadTs = details['__dup_existing_thread'] ?? '';

  console.log(`[intake] dup_check: existingConvoId=${existingConvoId}, existingChannel=${existingChannelId}, existingThread=${existingThreadTs}`);

  // User wants to continue in the other thread
  if (matchesAny(text, CONTINUE_THERE_PATTERNS)) {
    convo.setStatus('cancelled');
    await convo.save();
    const tsNoDot = existingThreadTs.replace('.', '');
    await say({
      text: `No problem! Here's your open conversation: https://slack.com/archives/${existingChannelId}/p${tsNoDot}\nJust reply there to pick up where you left off.`,
      thread_ts: threadTs,
    });
    return;
  }

  // User explicitly wants to start fresh here
  // In dup-check context, "here" unambiguously means "start fresh here"
  const DUP_CHECK_HERE_PATTERNS = [/^here$/i, /^this\s*(one|thread)$/i, /^right\s*here$/i, /^over\s*here$/i, /^in\s*here$/i];
  if (matchesAny(text, START_FRESH_PATTERNS) || matchesAny(text, RESET_PATTERNS) || matchesAny(text, DUP_CHECK_HERE_PATTERNS)) {
    await startFreshFromDupCheck(convo, existingConvoId, threadTs, say);
    return;
  }

  // User typed something that looks like an actual request (long enough to be content, not a command)
  // — start fresh and process their message as the first intake input
  if (text.length > 20) {
    await startFreshFromDupCheck(convo, existingConvoId, threadTs, say, text);
    return;
  }

  // Unrecognized short response — re-ask instead of silently cancelling
  await say({
    text: "Just checking — would you like to *continue there* (your open request) or *start fresh* here?",
    thread_ts: threadTs,
  });
}

async function startFreshFromDupCheck(
  convo: ConversationManager,
  existingConvoId: number,
  threadTs: string,
  say: SayFn,
  initialMessage?: string,
): Promise<void> {
  await cancelConversation(existingConvoId);
  convo.setCurrentStep(null);
  convo.markFieldCollected('additional_details', {});
  await convo.save();

  // Send welcome and start intake
  const welcomeMessages = [
    "Hey! Thanks for reaching out to marketing. I'd love to help you with this. I'm going to ask you a few quick questions so I can get your request to the right people.\n_If I ever pause or fail to reply, just say hello? and I'll pick back up._",
    "Hi! Thanks for reaching out to the marketing team. To get things moving, I'll walk you through a few quick questions about your request.\n_If I ever go quiet, just say hello? and I'll jump back in._",
    "Hey there! Glad you reached out to marketing. I'll just need to ask you a few questions to make sure we have everything we need to get started.\n_If I ever drop off, just say hello? and I'll pick up where we left off._",
    "Hi there! Thanks for coming to us. Let me ask you a few quick questions so we can get your request set up and into the right hands.\n_If I ever pause, just say hello? to get me back on track._",
  ];
  await say({
    text: welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)],
    thread_ts: threadTs,
  });

  // Confirm pre-filled name/department
  const dupData = convo.getCollectedData();
  if (dupData.requester_name || dupData.requester_department) {
    const namePart = dupData.requester_name;
    const deptPart = dupData.requester_department;
    let confirmMsg: string;
    if (namePart && deptPart) {
      confirmMsg = `I have you down as *${namePart}* from *${deptPart}*. If that's not right, just let me know — otherwise, let's jump in!`;
    } else if (namePart) {
      confirmMsg = `I have you down as *${namePart}*. If that's not right, just let me know — otherwise, let's jump in!`;
    } else {
      confirmMsg = `I have you down as part of *${deptPart}*. If that's not right, just let me know — otherwise, let's jump in!`;
    }
    await say({ text: confirmMsg, thread_ts: threadTs });
  }

  // If the user typed their actual request, process it now instead of losing it
  if (initialMessage) {
    await handleGatheringState(convo, initialMessage, threadTs, say);
    return;
  }

  await askNextQuestion(convo, threadTs, say);
}

async function handleGatheringState(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  // Empty @mention in an existing conversation — treat as a nudge
  if (text === '') {
    console.log(`[intake] Empty @mention in active conversation — re-asking current question`);
    await say({ text: "I'm here! Let me pick up where we left off.", thread_ts: threadTs });
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

  // Check for start over / start fresh
  if (matchesAny(text, RESET_PATTERNS) || matchesAny(text, START_FRESH_PATTERNS)) {
    convo.reset();
    await convo.save();
    await say({
      text: "Starting fresh! Let's begin again.",
      thread_ts: threadTs,
    });
    await askNextQuestion(convo, threadTs, say);
    return;
  }

  // Check for bare "here" / dup-check keywords that slipped through due to deploy race conditions.
  // Send the welcome + name confirmation the user expects, then ask the first question.
  const DUP_STALE_HERE = [/^here$/i, /^this\s*(one|thread)$/i, /^right\s*here$/i, /^over\s*here$/i, /^in\s*here$/i];
  if (matchesAny(text, DUP_STALE_HERE)) {
    console.log(`[intake] "here" keyword in gathering state (likely stale dup_check) — sending welcome + first question`);
    const welcomeMessages = [
      "Hey! Thanks for reaching out to marketing. I'd love to help you with this. I'm going to ask you a few quick questions so I can get your request to the right people.\n_If I ever pause or fail to reply, just say hello? and I'll pick back up._",
      "Hi! Thanks for reaching out to the marketing team. To get things moving, I'll walk you through a few quick questions about your request.\n_If I ever go quiet, just say hello? and I'll jump back in._",
      "Hey there! Glad you reached out to marketing. I'll just need to ask you a few questions to make sure we have everything we need to get started.\n_If I ever drop off, just say hello? and I'll pick up where we left off._",
      "Hi there! Thanks for coming to us. Let me ask you a few quick questions so we can get your request set up and into the right hands.\n_If I ever pause, just say hello? to get me back on track._",
    ];
    await say({ text: welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)], thread_ts: threadTs });

    const data = convo.getCollectedData();
    if (data.requester_name || data.requester_department) {
      let confirmMsg: string;
      if (data.requester_name && data.requester_department) {
        confirmMsg = `I have you down as *${data.requester_name}* from *${data.requester_department}*. If that's not right, just let me know — otherwise, let's jump in!`;
      } else if (data.requester_name) {
        confirmMsg = `I have you down as *${data.requester_name}*. If that's not right, just let me know — otherwise, let's jump in!`;
      } else {
        confirmMsg = `I have you down as part of *${data.requester_department}*. If that's not right, just let me know — otherwise, let's jump in!`;
      }
      await say({ text: confirmMsg, thread_ts: threadTs });
    }

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

  // --- Handle draft collection sub-flow ---
  const currentStep = convo.getCurrentStep();
  if (currentStep === 'draft:awaiting_link') {
    await handleDraftLink(convo, text, threadTs, say);
    return;
  }
  if (currentStep === 'draft:awaiting_readiness') {
    await handleDraftReadiness(convo, text, threadTs, say);
    return;
  }
  if (currentStep === 'draft:awaiting_expected_date') {
    await handleDraftExpectedDate(convo, text, threadTs, say);
    return;
  }
  if (currentStep === 'draft:awaiting_more') {
    await handleDraftMore(convo, text, threadTs, say);
    return;
  }

  // --- Nudge/greeting detection — resume the conversation (checked before follow-up so "hello" isn't stored as an answer) ---
  if (matchesAny(text, NUDGE_PATTERNS)) {
    await say({
      text: "I'm here! Let me pick up where we left off.",
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

  // --- IDK detection (works in both gathering and follow-up) ---
  if (matchesAny(text, IDK_PATTERNS)) {
    if (convo.isInFollowUp()) {
      await say({
        text: `No worries — you can say *skip* to move on, or give your best guess and the team will refine it.`,
        thread_ts: threadTs,
      });
    } else {
      const currentField = convo.getCurrentStep();
      if (currentField) {
        const guidance = await generateFieldGuidance(currentField, convo.getCollectedData());
        await say({ text: guidance, thread_ts: threadTs });
      } else {
        await say({
          text: "No worries — just tell me a bit about what you need and I'll help figure out the rest!",
          thread_ts: threadTs,
        });
        await askNextQuestion(convo, threadTs, say);
      }
    }
    return;
  }

  // --- "Needs discussion" flag (works in both gathering and follow-up) ---
  if (matchesAny(text, DISCUSS_PATTERNS)) {
    if (convo.isInFollowUp()) {
      const questions = getStoredFollowUpQuestions(convo);
      const idx = convo.getFollowUpIndex();
      if (questions && idx < questions.length) {
        const currentQuestion = questions[idx];
        flagForDiscussion(convo, currentQuestion.field_key, currentQuestion.question);
        const details = convo.getCollectedData().additional_details;
        details[currentQuestion.field_key] = '_needs discussion_';
        convo.markFieldCollected('additional_details', details);
        await say({
          text: `:speech_balloon: Flagged for discussion — the marketing team will follow up on this.`,
          thread_ts: threadTs,
        });
        const nextIndex = idx + 1;
        if (nextIndex >= questions.length) {
          await transitionToConfirming(convo, threadTs, say);
        } else {
          convo.setFollowUpIndex(nextIndex);
          await convo.save();
          await askFollowUpQuestion(convo, nextIndex, questions, threadTs, say);
        }
      } else {
        await transitionToConfirming(convo, threadTs, say);
      }
    } else {
      const currentField = convo.getCurrentStep();
      if (currentField) {
        flagForDiscussion(convo, currentField, currentField);
        convo.markFieldCollected(currentField as keyof CollectedData, '_needs discussion_');
        await convo.save();
        await say({
          text: `:speech_balloon: Flagged *${formatFieldLabel(currentField)}* for discussion — the marketing team will follow up on this. Let's keep going!`,
          thread_ts: threadTs,
        });
        if (convo.isComplete()) {
          await enterFollowUpPhase(convo, 1, threadTs, say);
        } else {
          await askNextQuestion(convo, threadTs, say);
        }
      } else {
        await say({
          text: "I'd be happy to flag something for discussion — which part of the request would you like to talk through?",
          thread_ts: threadTs,
        });
      }
    }
    return;
  }

  // --- Handle follow-up phase ---
  if (convo.isInFollowUp()) {
    await handleFollowUpAnswer(convo, text, threadTs, say);
    return;
  }

  // Interpret the message via Claude
  const preData = convo.getCollectedData();
  console.log(`[intake] Calling Claude to interpret: "${text.substring(0, 80)}" for convo threadTs=${convo.getThreadTs()}, replyThreadTs=${threadTs}`);
  console.log(`[intake] PRE-Claude state: target=${preData.target ? 'SET' : 'null'}, context=${preData.context_background ? 'SET' : 'null'}, outcomes=${preData.desired_outcomes ? '"' + preData.desired_outcomes.substring(0, 40) + '"' : 'null'}, deliverables=${JSON.stringify(preData.deliverables)}, due_date=${preData.due_date ?? 'null'}`);
  try {
    const extracted = await interpretMessage(text, convo.getCollectedData(), undefined, convo.getCurrentStep());
    console.log(`[intake] Claude response: confidence=${extracted.confidence}, department=${extracted.requester_department}`);
    console.log(`[intake] Claude extracted: outcomes=${extracted.desired_outcomes ? '"' + extracted.desired_outcomes.substring(0, 40) + '"' : 'null'}, deliverables=${JSON.stringify(extracted.deliverables)}, target=${extracted.target ? '"' + extracted.target.substring(0, 30) + '"' : 'null'}, context=${extracted.context_background ? '"' + extracted.context_background.substring(0, 30) + '"' : 'null'}`);
    const fieldsApplied = applyExtractedFields(convo, extracted);
    const postData = convo.getCollectedData();
    console.log(`[intake] POST-apply state (${fieldsApplied} fields): outcomes=${postData.desired_outcomes ? '"' + postData.desired_outcomes.substring(0, 40) + '"' : 'null'}, deliverables=${JSON.stringify(postData.deliverables)}, due_date=${postData.due_date ?? 'null'}`);

    if (fieldsApplied === 0) {
      const step = convo.getCurrentStep();

      const isSubstantive = text.length > 5 && !matchesAny(text, NUDGE_PATTERNS) && !matchesAny(text, SKIP_PATTERNS);
      const isRequiredField = step && GATHERING_FIELDS.includes(step as keyof CollectedData);

      if (isSubstantive && isRequiredField) {
        // Claude didn't extract it, but the user clearly answered — store the raw text
        console.log(`[intake] Claude returned 0 fields but message looks substantive — storing raw text for field=${step}`);
        if (step === 'deliverables' || step === 'supporting_links') {
          convo.markFieldCollected(step as keyof CollectedData, [text]);
        } else {
          convo.markFieldCollected(step as keyof CollectedData, text);
        }
        await convo.save();

        await say({ text: 'Got it!', thread_ts: threadTs });

        if (convo.isComplete()) {
          await enterFollowUpPhase(convo, 1, threadTs, say);
        } else {
          await askNextQuestion(convo, threadTs, say);
        }
      } else {
        console.log(`[intake] No fields applied (confidence=${extracted.confidence}, currentStep=${step}, substantive=${isSubstantive})`);
        await say({
          text: "I didn't quite catch that. Could you rephrase?",
          thread_ts: threadTs,
        });
        // Re-ask the current question
        await askNextQuestion(convo, threadTs, say);
      }
      return;
    }

    // Build a contextual acknowledgment of what was just captured
    const ack = buildFieldAcknowledgment(convo, extracted);
    if (ack) {
      await say({ text: ack, thread_ts: threadTs });
    }

    // Show production timeline if we just captured a due date
    if (extracted.due_date_parsed) {
      const timeline = generateProductionTimeline(convo.getCollectedData());
      if (timeline) {
        await say({ text: timeline, thread_ts: threadTs });
      }
    }

    // Detect project keywords — silently store matching projects for the triage message
    const details = convo.getCollectedData().additional_details;
    if (extracted.project_keywords && extracted.project_keywords.length > 0 && !details['__project_match_searched']) {
      let projectMatches: ProjectMatch[] = [];
      try {
        projectMatches = await searchForProjectMatches(extracted.project_keywords);
      } catch (searchErr) {
        console.error('[intake] Project match search failed (non-fatal):', searchErr);
      }
      details['__project_match_searched'] = 'true';
      if (projectMatches.length > 0) {
        details['__related_projects'] = JSON.stringify(projectMatches.map((m) => m.name));
        console.log(`[intake] Found ${projectMatches.length} related project(s): ${projectMatches.map((m) => m.name).join(', ')}`);
      }
      convo.markFieldCollected('additional_details', details);
    }

    // Detect mentions of existing content — start draft collection mini-flow
    if (mentionsExistingContent(text) && !details['draft_link'] && !details['__draft_asked']) {
      // Mark that we've asked so we don't re-trigger, and save current step to resume
      details['__draft_asked'] = 'true';
      details['__pre_draft_step'] = convo.getCurrentStep() ?? '';
      convo.markFieldCollected('additional_details', details);
      convo.setCurrentStep('draft:awaiting_link');
      await convo.save();
      await say({
        text: "It sounds like you have some existing content or a draft started — that's super helpful! Can you share a Google Drive link so we can take a look?\n_If you don't have a link handy, just say *skip* and you can share it later._",
        thread_ts: threadTs,
      });
      return;
    }

    // Check if all required fields are now collected
    await convo.save();
    if (convo.isComplete()) {
      // Enter follow-up phase
      await enterFollowUpPhase(convo, fieldsApplied, threadTs, say);
    } else {

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
    await say({
      text: `No worries — you can say *skip* to move on, or give your best guess and the team will refine it.`,
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

    await say({
      text: `:speech_balloon: Flagged for discussion — the marketing team will follow up on this.`,
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

  // Detect mentions of existing content in follow-up answers
  const followUpDetails = convo.getCollectedData().additional_details;
  if (mentionsExistingContent(text) && !followUpDetails['draft_link'] && !followUpDetails['__draft_asked']) {
    followUpDetails['__draft_asked'] = 'true';
    followUpDetails['__pre_draft_step'] = convo.getCurrentStep() ?? '';
    convo.markFieldCollected('additional_details', followUpDetails);
    convo.setCurrentStep('draft:awaiting_link');
    await convo.save();
    await say({
      text: "It sounds like you have some existing content or a draft — nice! Can you share a Google Drive link so we can pull it in?\n_Say *skip* if you don't have a link handy._",
      thread_ts: threadTs,
    });
    return;
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
  await convo.save();

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
  await convo.save();

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
  await convo.save();

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
  await convo.save();

  await say({
    text: "Your request has been withdrawn.",
    thread_ts: threadTs,
  });

  // Update Monday.com
  const mondayItemId = convo.getMondayItemId();
  if (mondayItemId) {
    try {
      await updateMondayItemStatus(mondayItemId, 'Withdrawn');
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

// --- Draft/existing content collection mini-flow ---

interface ExistingAsset {
  link: string;
  status: string; // 'Ready' or 'In progress — expected [date]'
}

function getExistingAssets(convo: ConversationManager): ExistingAsset[] {
  const raw = convo.getCollectedData().additional_details['__existing_assets'];
  if (!raw) return [];
  try { return JSON.parse(raw) as ExistingAsset[]; } catch { return []; }
}

function saveExistingAssets(convo: ConversationManager, assets: ExistingAsset[]): void {
  const details = convo.getCollectedData().additional_details;
  details['__existing_assets'] = JSON.stringify(assets);
  convo.markFieldCollected('additional_details', details);
}

async function handleDraftLink(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  if (matchesAny(text, SKIP_PATTERNS)) {
    const assets = getExistingAssets(convo);
    if (assets.length === 0) {
      const details = convo.getCollectedData().additional_details;
      details['draft_link'] = '_will share later_';
      convo.markFieldCollected('additional_details', details);
    }
    restoreStepAfterDraft(convo);
    await convo.save();
    await say({
      text: "No problem — you can share links anytime in this thread after submitting. Let's continue!",
      thread_ts: threadTs,
    });
    await resumeAfterDraft(convo, threadTs, say);
    return;
  }

  // Extract URL or store as description
  const urlMatch = text.match(/<(https?:\/\/[^|>]+)/i) ?? text.match(/(https?:\/\/\S+)/i);
  const details = convo.getCollectedData().additional_details;
  details['__current_draft_link'] = urlMatch ? urlMatch[1] : text;
  convo.markFieldCollected('additional_details', details);
  convo.setCurrentStep('draft:awaiting_readiness');
  await convo.save();

  await say({
    text: `Got it! Is this ${urlMatch ? 'content' : 'draft'} ready for marketing to work with, or is it still in progress?\n_Just say *ready* or *in progress*._`,
    thread_ts: threadTs,
  });
}

async function handleDraftReadiness(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  const lower = text.toLowerCase().trim();
  const details = convo.getCollectedData().additional_details;
  const currentLink = details['__current_draft_link'] ?? '';

  const isReady = /^(ready|done|finished|good\s*to\s*go|yes|yep|it'?s?\s*ready)/i.test(lower);
  const isInProgress = /^(in\s*progress|not\s*(yet|ready|done)|still\s*(working|in progress|drafting)|wip|needs?\s*(work|more))/i.test(lower);

  if (isReady) {
    const assets = getExistingAssets(convo);
    assets.push({ link: currentLink, status: 'Ready' });
    saveExistingAssets(convo, assets);
    delete details['__current_draft_link'];
    convo.markFieldCollected('additional_details', details);
    convo.setCurrentStep('draft:awaiting_more');
    await convo.save();
    await say({
      text: "Great — we'll pull it in! Do you have any other existing content or links to share? (landing pages, email drafts, slide decks, etc.)\n_Say *done* if that's everything._",
      thread_ts: threadTs,
    });
  } else if (isInProgress || matchesAny(text, SKIP_PATTERNS)) {
    convo.setCurrentStep('draft:awaiting_expected_date');
    await convo.save();
    await say({
      text: "No problem! When do you think the draft will be ready? This way we can plan around it.\n_e.g., \"end of this week\", \"by March 10\", or say *skip* if you're not sure yet._",
      thread_ts: threadTs,
    });
  } else {
    await say({
      text: "Just to make sure — is this *ready* for marketing to use, or is it still *in progress*?",
      thread_ts: threadTs,
    });
  }
}

async function handleDraftExpectedDate(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  const details = convo.getCollectedData().additional_details;
  const currentLink = details['__current_draft_link'] ?? '';
  const expectedDate = matchesAny(text, SKIP_PATTERNS) ? 'TBD' : text;

  const assets = getExistingAssets(convo);
  assets.push({ link: currentLink, status: `In progress — expected ${expectedDate}` });
  saveExistingAssets(convo, assets);
  delete details['__current_draft_link'];
  convo.markFieldCollected('additional_details', details);
  convo.setCurrentStep('draft:awaiting_more');
  await convo.save();

  await say({
    text: `:memo: Noted — we'll follow up around ${expectedDate === 'TBD' ? 'that time' : expectedDate}. Do you have any other existing content or links to share?\n_Say *done* if that's everything._`,
    thread_ts: threadTs,
  });
}

async function handleDraftMore(
  convo: ConversationManager,
  text: string,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  // Check if user is done adding content
  if (matchesAny(text, DONE_PATTERNS) || matchesAny(text, SKIP_PATTERNS) || /^(no|nope|that'?s?\s*(it|all)|nothing)/i.test(text.trim())) {
    restoreStepAfterDraft(convo);
    await convo.save();
    const assets = getExistingAssets(convo);
    await say({
      text: `Got it — ${assets.length} existing asset${assets.length === 1 ? '' : 's'} linked. Let's keep going!`,
      thread_ts: threadTs,
    });
    await resumeAfterDraft(convo, threadTs, say);
    return;
  }

  // User is providing another link — capture it and ask about readiness
  const urlMatch = text.match(/<(https?:\/\/[^|>]+)/i) ?? text.match(/(https?:\/\/\S+)/i);
  const details = convo.getCollectedData().additional_details;
  details['__current_draft_link'] = urlMatch ? urlMatch[1] : text;
  convo.markFieldCollected('additional_details', details);
  convo.setCurrentStep('draft:awaiting_readiness');
  await convo.save();

  await say({
    text: "Got it! Is this one ready for marketing, or still in progress?\n_Just say *ready* or *in progress*._",
    thread_ts: threadTs,
  });
}

/** Save the pre-draft step so we can resume after the mini-flow. */
function restoreStepAfterDraft(convo: ConversationManager): void {
  const details = convo.getCollectedData().additional_details;
  const savedStep = details['__pre_draft_step'];
  if (savedStep) {
    convo.setCurrentStep(savedStep);
    delete details['__pre_draft_step'];
    convo.markFieldCollected('additional_details', details);
  }
}

/** Resume normal flow after draft collection is done. */
async function resumeAfterDraft(
  convo: ConversationManager,
  threadTs: string,
  say: SayFn,
): Promise<void> {
  if (convo.isInFollowUp()) {
    const questions = getStoredFollowUpQuestions(convo);
    const index = convo.getFollowUpIndex();
    if (questions && index < questions.length) {
      // Advance past the current follow-up (already answered before draft detour)
      const details = convo.getCollectedData().additional_details;
      let nextIndex = index + 1;
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
    } else {
      await transitionToConfirming(convo, threadTs, say);
    }
  } else if (convo.isComplete()) {
    await enterFollowUpPhase(convo, 1, threadTs, say);
  } else {
    await askNextQuestion(convo, threadTs, say);
  }
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

  console.log(`[intake] askNextQuestion → field=${next.field}, step=${convo.getCurrentStep()}`);

  await convo.save();

  await say({
    text: `${next.question}\n_${next.example}_`,
    thread_ts: threadTs,
  });
}

/**
 * Apply extracted fields from Claude to the conversation.
 * Returns the number of fields that were newly applied.
 *
 * @param allowOverwrite - When false (default), already-populated fields are never
 *   overwritten. This prevents Claude from clobbering previously-collected answers
 *   with misinterpreted values from unrelated messages. Set to true only in the
 *   confirming state where the user is explicitly correcting fields.
 */
function applyExtractedFields(
  convo: ConversationManager,
  extracted: ExtractedFields,
  allowOverwrite = false,
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
    if (typeof newValue === 'string' && newValue.trim() === '') continue;

    // Check if field is already populated
    const currentValue = current[field as keyof CollectedData];
    const currentlyPopulated = Array.isArray(currentValue)
      ? currentValue.length > 0
      : currentValue !== null && currentValue !== '';

    if (currentlyPopulated) {
      if (!allowOverwrite) {
        // During gathering/recovery: never overwrite — prevents Claude from
        // clobbering a real answer with a hallucinated one from a later message
        continue;
      }
      // During confirming (allowOverwrite=true): skip if the value is identical
      if (Array.isArray(currentValue) && Array.isArray(newValue)) {
        if (JSON.stringify(currentValue) === JSON.stringify(newValue)) continue;
      } else if (currentValue === newValue) {
        continue;
      }
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

/**
 * Build a contextual acknowledgment message after extracting fields from a user's message.
 * Uses Claude's generated acknowledgment when available, with template fallback.
 * Appends info about pre-filled fields the user didn't need to provide.
 */
function buildFieldAcknowledgment(
  convo: ConversationManager,
  extracted: ExtractedFields,
): string | null {
  const parts: string[] = [];
  const data = convo.getCollectedData();

  // Use Claude's acknowledgment if available — it's always grammatically correct
  if (extracted.acknowledgment) {
    parts.push(extracted.acknowledgment);
  } else if (extracted.requester_name) {
    parts.push(`Thanks, ${extracted.requester_name}!`);
  } else {
    parts.push('Got it, thanks for sharing that.');
  }

  // Pre-filled info is now confirmed upfront in the welcome flow,
  // so we don't need to mention it again during gathering.

  return parts.join(' ');
}
