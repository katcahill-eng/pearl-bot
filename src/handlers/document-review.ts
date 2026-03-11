import type { SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager } from '../lib/conversation';
import { postQCTriagePanel } from './approval';
import { createMondayItemForReview } from '../lib/workflow';
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
    const data = convo.getCollectedData();

    convo.markFieldCollected('additional_details', {
      ...data.additional_details,
      __due_date: dueDate,
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

  // Step 3: Post to triage
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
        requesterName: displayName,
      });
    }
  } catch (err) {
    console.error('[document-review] Failed to post triage panel:', err);
  }

  // Step 4: Create Monday item
  try {
    const collectedData = convo.getCollectedData();
    collectedData.context_background = `Document review: ${docType ?? 'document'}`;
    collectedData.deliverables = ['Document Review'];
    collectedData.target = 'Internal — Marketing';
    collectedData.desired_outcomes = `${reviewType} review requested`;

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
      const convId = convo.getId();
      if (convId) {
        await updateMondayItemId(convId, mondayResult.itemId);
      }
    }
  } catch (err) {
    console.error('[document-review] Failed to create Monday item:', err);
  }

  // Step 5: Mark conversation complete
  convo.setStatus('pending_approval');
  convo.setCurrentStep('doc_review:complete');
  await convo.save();
}
