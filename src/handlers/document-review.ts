import type { SayFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../lib/config';
import { ConversationManager } from '../lib/conversation';
import { readGoogleDoc } from '../lib/google-docs-reader';
import { runQC, type QCResult } from '../lib/qc-runner';
import { generateQCExcel } from '../lib/excel-generator';
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

function isGoogleDoc(url: string): boolean {
  return /docs\.google\.com\/document\/d\//.test(url);
}

function isCancelMessage(text: string): boolean {
  const trimmed = text.trim();
  return CANCEL_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Generate a triage-friendly project name for document reviews.
 */
function docReviewProjectName(docTitle: string): string {
  const name = `Doc Review: ${docTitle}`;
  return name.length > 80 ? name.slice(0, 77) + '...' : name;
}

/**
 * Build the full report card as a threaded Slack message.
 */
function buildFullReportCard(result: QCResult): string {
  const lines: string[] = [
    ':clipboard: *Full QC Report Card*',
    '',
  ];

  // Critical issues
  if (result.criticalIssues.length > 0) {
    lines.push(':red_circle: *Critical Issues (must fix):*');
    for (let i = 0; i < result.criticalIssues.length; i++) {
      const issue = result.criticalIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Important issues
  if (result.importantIssues.length > 0) {
    lines.push(':warning: *Important Issues (should fix):*');
    for (let i = 0; i < result.importantIssues.length; i++) {
      const issue = result.importantIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Minor issues
  if (result.minorIssues.length > 0) {
    lines.push(':large_blue_circle: *Minor Issues (nice to fix):*');
    for (let i = 0; i < result.minorIssues.length; i++) {
      const issue = result.minorIssues[i];
      lines.push(`${i + 1}. *${issue.category}* [${issue.confidence}]`);
      lines.push(`   _Original:_ "${issue.originalText}"`);
      lines.push(`   _Issue:_ ${issue.issue}`);
      lines.push(`   _Fix:_ ${issue.suggestedFix}`);
      lines.push('');
    }
  }

  // Positioning stress test
  if (result.positioningStressTest) {
    lines.push('*Positioning Stress Test:*');
    lines.push(result.positioningStressTest);
    lines.push('');
  }

  // Bunny detection
  if (result.bunnyDetection) {
    lines.push('*Bunny Detection Test:*');
    lines.push(result.bunnyDetection);
    lines.push('');
  }

  // Brand essence tone check
  if (result.brandEssenceToneCheck) {
    lines.push('*Brand Essence / Tone Check:*');
    lines.push(result.brandEssenceToneCheck);
    lines.push('');
  }

  // Data provenance audit
  if (result.dataProvenanceAudit) {
    lines.push('*Data Provenance Audit:*');
    lines.push(result.dataProvenanceAudit);
    lines.push('');
  }

  // Overall assessment
  if (result.overallAssessment) {
    lines.push('*Overall Positioning Assessment:*');
    lines.push(result.overallAssessment);
  }

  // Truncate if too long for Slack (max ~40000 chars per message)
  const fullText = lines.join('\n');
  if (fullText.length > 39000) {
    return fullText.slice(0, 39000) + '\n\n_... report truncated due to length. See Excel file for full details._';
  }

  return fullText;
}

// --- Main handler ---

/**
 * Handle document review conversation flow.
 * Steps: doc_review:link → doc_review:context → doc_review:running
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

  let docTitle = 'Unknown Document';
  let qcResult: QCResult | null = null;
  let qcError: string | null = null;
  let excelBuffer: Buffer | null = null;

  // Only attempt automatic QC for Google Docs
  if (isGoogleDoc(docUrl)) {
    let docContent = '';

    // Step 1: Fetch document content
    try {
      const doc = await readGoogleDoc(docUrl);
      docTitle = doc.title;
      docContent = doc.content;

      if (!docContent || docContent.trim().length === 0) {
        throw new Error('Document appears to be empty');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error reading document';
      console.error('[document-review] Failed to read Google Doc:', message);
      // Don't block — submit to triage without QC
    }

    // Step 2: Run QC (if we got content)
    if (docContent) {
      try {
        qcResult = await runQC(docContent, docType);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error during QC';
        console.error('[document-review] QC runner failed:', message);
        qcError = `QC review failed: ${message}`;
      }
    }

    // Step 3: Generate Excel (if QC succeeded)
    if (qcResult) {
      try {
        excelBuffer = await generateQCExcel(qcResult, docTitle);
      } catch (err) {
        console.error('[document-review] Excel generation failed:', err);
        // Non-critical — continue without the Excel file
      }

      // Store QC metadata
      const updatedData = convo.getCollectedData();
      convo.markFieldCollected('additional_details', {
        ...updatedData.additional_details,
        __qc_grade: qcResult.grade,
        __qc_summary: qcResult.summary,
      });
    }
  }

  // Step 4: Post confirmation to user (same message regardless of QC outcome)
  await say({
    text: ":white_check_mark: Thanks! Your document has been submitted to the marketing team for review. Any updates will be posted in this thread.",
    thread_ts: threadTs,
  });

  // Step 5: Resolve user display name
  let displayName = userName;
  try {
    const userInfo = await client.users.info({ user: userId });
    displayName = userInfo.user?.real_name ?? userInfo.user?.name ?? userName;
  } catch {
    // Fall back to userId
  }

  // Also store requester name for downstream use
  convo.markFieldCollected('requester_name', displayName);

  // Step 6: Post to triage
  try {
    const conversationId = convo.getId();
    if (conversationId) {
      await postQCTriagePanel({
        client,
        conversationId,
        docTitle,
        docUrl,
        docType: docType ?? 'Not specified',
        requesterName: displayName,
        qcResult,
        qcError,
        excelBuffer,
      });
    }
  } catch (err) {
    console.error('[document-review] Failed to post triage panel:', err);
  }

  // Step 7: Create Monday item
  try {
    const collectedData = convo.getCollectedData();
    // Set up data for Monday
    collectedData.context_background = `Document QC review: ${docTitle}`;
    collectedData.deliverables = ['Document QC Review'];
    collectedData.target = 'Internal — Marketing QC';
    collectedData.desired_outcomes = qcResult
      ? `QC Grade: ${qcResult.grade} — ${qcResult.summary}`
      : 'QC review pending';

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
    // Non-critical — don't fail the whole flow
  }

  // Step 8: Mark conversation complete
  convo.setStatus('pending_approval');
  convo.setCurrentStep('doc_review:complete');
  await convo.save();
}
