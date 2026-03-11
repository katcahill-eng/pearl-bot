import type { SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager } from '../lib/conversation';
import { postQCTriagePanel } from './approval';
import { createMondayItemForReview } from '../lib/workflow';
import { buildMondayUrl } from '../lib/monday';
import { updateMondayItemId } from '../lib/db';

// --- Patterns ---

const URL_PATTERN = /(?:https?:\/\/)[^\s<>]+/;
const CANCEL_PATTERNS = [
  /^cancel$/i, /^nevermind$/i, /^never\s*mind/i, /^forget\s*(about\s*)?it$/i,
  /^nvm$/i, /^stop$/i, /^abort$/i, /^quit$/i, /^scratch\s*that$/i,
  /^no\s*thanks/i,
];

// --- Helpers ---

function extractDocUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

/**
 * Try to parse a human-readable date into YYYY-MM-DD.
 * Handles: "Friday", "next Friday", "March 15", "3/15", "end of week", "ASAP", etc.
 */
function parseDueDate(input: string): string | null {
  const trimmed = input.trim().toLowerCase();

  // Skip non-date responses
  if (/^(asap|no rush|whenever|no deadline|flexible|tbd|n\/a)$/i.test(trimmed)) {
    return null;
  }

  // Try direct ISO date
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoMatch) return isoMatch[1];

  // Try MM/DD or MM/DD/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10);
    const day = parseInt(slashMatch[2], 10);
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Day of week
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < days.length; i++) {
    if (trimmed.includes(days[i])) {
      const today = new Date();
      const todayDay = today.getDay();
      let diff = i - todayDay;
      if (diff <= 0) diff += 7; // next occurrence
      const target = new Date(today);
      target.setDate(today.getDate() + diff);
      return target.toISOString().split('T')[0];
    }
  }

  // "end of week" / "end of day friday" / "eow"
  if (/end\s+of\s+(the\s+)?week|eow/i.test(trimmed)) {
    const today = new Date();
    const diff = 5 - today.getDay();
    const friday = new Date(today);
    friday.setDate(today.getDate() + (diff <= 0 ? diff + 7 : diff));
    return friday.toISOString().split('T')[0];
  }

  // Month + day: "March 15", "Mar 15"
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
  const monthMatch = trimmed.match(/^(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?$/);
  if (monthMatch) {
    const monthNum = months[monthMatch[1]];
    if (monthNum) {
      const day = parseInt(monthMatch[2], 10);
      const year = monthMatch[3] ? parseInt(monthMatch[3], 10) : new Date().getFullYear();
      return `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

function isCancelMessage(text: string): boolean {
  const trimmed = text.trim();
  return CANCEL_PATTERNS.some((p) => p.test(trimmed));
}

// --- Main handler ---

/**
 * Handle document review conversation flow.
 * Steps: doc_review:link → doc_review:context → doc_review:review_type → doc_review:running
 */
export async function handleDocumentReviewMessage(opts: {
  userId: string;
  userName: string;
  channelId: string;
  threadTs: string;
  text: string;
  files?: { id: string; name: string; permalink: string; urlPrivate: string }[];
  say: SayFn;
  client: WebClient;
}): Promise<void> {
  const { userId, userName, channelId, threadTs, text, say, client } = opts;

  // Load or create conversation
  let convo = await ConversationManager.load(userId, threadTs);

  if (!convo) {
    // New document review conversation
    convo = new ConversationManager({
      userId,
      userName,
      channelId,
      threadTs,
      status: 'gathering',
      currentStep: 'doc_review:link',
    });
    convo.setRequestType('document_review');

    // Check if the initial message already contains a URL
    const docUrl = extractDocUrl(text);

    if (docUrl) {
      // User provided a link right away — store it and ask for context
      convo.getCollectedData(); // ensure we have access
      convo.markFieldCollected('additional_details', {
        ...convo.getCollectedData().additional_details,
        __doc_url: docUrl,
      });
      convo.setCurrentStep('doc_review:context');
      await convo.save();

      await say({
        text: "Got it! What kind of document is this?\n\n_e.g., blog post, landing page, email copy, press release, one-pager, slide deck, video script_",
        thread_ts: threadTs,
      });
      return;
    }

    // No URL in the message — ask for one
    await convo.save();
    await say({
      text: "Sure! Please share the link to the document you'd like reviewed.",
      thread_ts: threadTs,
    });
    return;
  }

  // Existing conversation — route based on current step
  const currentStep = convo.getCurrentStep();

  // Check for cancellation at any point
  if (isCancelMessage(text)) {
    convo.setStatus('cancelled');
    await convo.save();
    await say({
      text: 'No problem, document review cancelled. Let me know if you need anything else!',
      thread_ts: threadTs,
    });
    return;
  }

  // --- Step: Waiting for document link ---
  if (currentStep === 'doc_review:link') {
    const docUrl = extractDocUrl(text);

    if (!docUrl) {
      await say({
        text: "I didn't see a link in your message. Please share the full URL to the document you'd like reviewed.",
        thread_ts: threadTs,
      });
      return;
    }

    const data = convo.getCollectedData();
    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __doc_url: docUrl,
    });
    convo.setCurrentStep('doc_review:context');
    await convo.save();

    await say({
      text: "Got it! What kind of document is this?\n\n_e.g., blog post, landing page, email copy, press release, one-pager, slide deck, video script_",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Step: Waiting for document type/context ---
  if (currentStep === 'doc_review:context') {
    const docType = text.trim();
    const data = convo.getCollectedData();

    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __doc_type: docType,
    });
    convo.setCurrentStep('doc_review:review_type');
    await convo.save();

    await say({
      text: "What would you like marketing to focus on?\n\n" +
        "• *Brand compliance* — terminology, messaging, positioning\n" +
        "• *Design review* — layout, graphics, product photos, formatting\n" +
        "• *Content flow* — structure, readability, narrative\n" +
        "• *Full review* — all of the above\n\n" +
        "_You can pick one or describe what you need._",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Step: Waiting for review type ---
  if (currentStep === 'doc_review:review_type') {
    const reviewType = text.trim();
    const data = convo.getCollectedData();

    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __review_type: reviewType,
    });
    convo.setCurrentStep('doc_review:due_date');
    await convo.save();

    await say({
      text: "When do you need this review completed by?\n\n_e.g., end of day Friday, March 15, no rush, ASAP_",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Step: Waiting for due date ---
  if (currentStep === 'doc_review:due_date') {
    const dueDate = text.trim();
    const parsedDate = parseDueDate(dueDate);
    const data = convo.getCollectedData();

    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __due_date: dueDate,
      __due_date_parsed: parsedDate ?? '',
    });
    convo.setCurrentStep('doc_review:send_to');
    await convo.save();

    await say({
      text: "Last question — should we send the feedback back to you, or is there someone else who should be looped in?\n\n_e.g., \"send it to me\", \"loop in Sarah and Mike\", \"send to the whole team\"_",
      thread_ts: threadTs,
    });
    return;
  }

  // --- Step: Waiting for feedback recipient ---
  if (currentStep === 'doc_review:send_to') {
    const sendTo = text.trim();
    const data = convo.getCollectedData();

    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __send_to: sendTo,
    });
    convo.setCurrentStep('doc_review:running');
    await convo.save();

    // Start the review process
    await say({
      text: ':mag: Submitting your document for review...',
      thread_ts: threadTs,
    });

    await executeDocumentReview({
      convo,
      userId,
      userName,
      channelId,
      threadTs,
      say,
      client,
    });
    return;
  }

  // --- Step: QC already running or complete ---
  if (currentStep === 'doc_review:running') {
    await say({
      text: "The quality review is still in progress. I'll post the results as soon as it's done!",
      thread_ts: threadTs,
    });
    return;
  }

  // If we get here with a doc review conversation that's complete or in an unexpected state,
  // just acknowledge
  await say({
    text: 'This document review has already been completed. Start a new request if you need another review!',
    thread_ts: threadTs,
  });
}

// --- QC Execution ---

async function executeDocumentReview(opts: {
  convo: ConversationManager;
  userId: string;
  userName: string;
  channelId: string;
  threadTs: string;
  say: SayFn;
  client: WebClient;
}): Promise<void> {
  const { convo, userId, userName, channelId, threadTs, say, client } = opts;
  const data = convo.getCollectedData();
  const docUrl = data.additional_details['__doc_url'];
  const docType = data.additional_details['__doc_type'];
  const reviewType = data.additional_details['__review_type'] ?? 'Full review';
  const dueDate = data.additional_details['__due_date'] ?? 'Not specified';
  const dueDateParsed = data.additional_details['__due_date_parsed'] || null;
  const sendTo = data.additional_details['__send_to'] ?? 'Requester';

  // Step 1: Post confirmation to user
  await say({
    text: ":white_check_mark: Thanks! Your document has been submitted to the marketing team for review. Any updates will be posted in this thread.",
    thread_ts: threadTs,
  });

  // Step 2: Resolve user display name
  let displayName = userName;
  try {
    const userInfo = await client.users.info({ user: userId });
    displayName = userInfo.user?.real_name ?? userInfo.user?.name ?? userName;
  } catch {
    // Fall back to userId
  }

  convo.markFieldCollected('requester_name', displayName);

  // Step 3: Create Monday item
  let mondayUrl: string | null = null;
  try {
    const collectedData = convo.getCollectedData();
    collectedData.context_background = `Document review (${docType ?? 'document'}): ${reviewType}`;
    collectedData.deliverables = ['Document Review'];
    collectedData.target = 'Internal — Marketing';
    collectedData.desired_outcomes = `${reviewType} review requested`;
    collectedData.due_date_parsed = dueDateParsed;
    collectedData.due_date = dueDate;

    const mondayResult = await createMondayItemForReview({
      collectedData,
      classification: 'quick',
      requesterName: displayName,
      requesterSlackId: userId,
      requestTypes: ['document_review'],
      channelId,
      threadTs,
      client,
    });

    if (mondayResult.success && mondayResult.itemId) {
      convo.setMondayItemId(mondayResult.itemId);
      mondayUrl = buildMondayUrl(mondayResult.itemId);
      const convId = convo.getId();
      if (convId) {
        await updateMondayItemId(convId, mondayResult.itemId);
      }

      // Post review details as a Monday update
      try {
        const { addMondayItemUpdate } = await import('../lib/monday');
        const updateBody = [
          `Document Review Details:`,
          ``,
          `• Document type: ${docType ?? 'Not specified'}`,
          `• Review requested: ${reviewType}`,
          `• Due: ${dueDate}`,
          `• Send feedback to: ${sendTo}`,
          `• Document: ${docUrl}`,
        ].join('\n');
        await addMondayItemUpdate(mondayResult.itemId, updateBody);
      } catch (err) {
        console.error('[document-review] Failed to add Monday update:', err);
      }
    }
  } catch (err) {
    console.error('[document-review] Failed to create Monday item:', err);
  }

  // Step 4: Post to triage (with Monday URL if available)
  try {
    const conversationId = convo.getId();
    if (conversationId) {
      await postQCTriagePanel({
        client,
        conversationId,
        docUrl,
        docType: docType ?? 'Not specified',
        reviewType,
        dueDate,
        sendTo,
        requesterName: displayName,
        mondayUrl,
      });
    }
  } catch (err) {
    console.error('[document-review] Failed to post triage panel:', err);
  }

  // Step 5: Mark conversation complete
  convo.setStatus('pending_approval');
  convo.setCurrentStep('doc_review:complete');
  await convo.save();
}
