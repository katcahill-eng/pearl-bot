/**
 * Sage v2 light-QC handler.
 *
 * Wraps the existing v3 qc-runner with v2-friendly output formatting and
 * pub-bound detection. Per PRD US-007:
 *
 * - Self-service light QC ("is this on-brand: [paste]") returns a brief
 *   Slack reply with grade + critical issues + AI disclaimer.
 * - Pub-bound content (user mentions "for publication" / detected) is
 *   routed to the request modal instead — pub-bound QC goes to triage,
 *   never back to the requester as self-service.
 *
 * The pub-bound detection is intentionally conservative: a regex pass
 * for explicit signal phrases. False negatives (pub-bound content not
 * caught) are safer than false positives (forcing a modal for someone
 * who just wants quick feedback).
 */

import { runQC, type QCResult } from '../lib/qc-runner';
import { withDisclaimer } from '../lib/disclaimer';
import { readGoogleDoc, extractDocId } from '../lib/google-docs-reader';

const GOOGLE_DOC_PATTERN = /https?:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_\-/]+/;

function extractGoogleDocUrl(text: string): string | null {
  const match = text.match(GOOGLE_DOC_PATTERN);
  return match ? match[0] : null;
}

const PUB_BOUND_PATTERNS: RegExp[] = [
  /\bfor\s+publication\b/i,
  /\bgoing\s+(live|public)\b/i,
  /\bship(ping)?\s+(this|today|tomorrow)\b/i,
  /\bpublishing\s+(today|tomorrow|this\s+week)\b/i,
  /\bbefore\s+(it\s+)?(goes|ships)\s+live\b/i,
  /\bpre[\s-]?launch\b/i,
];

export function isPubBound(text: string): boolean {
  return PUB_BOUND_PATTERNS.some((re) => re.test(text));
}

/**
 * Extract the actual content to QC from the @mention text. Strips the
 * leading bot mention and common preamble like "is this on-brand:".
 */
export function extractQCContent(text: string): string {
  return text
    .replace(/^<@[A-Z0-9]+>\s*/, '')
    .replace(/^(is\s+this\s+(on[\s-]?brand|good)|qc[\s:,]|review[\s:,])\s*[:,]?\s*/i, '')
    .trim();
}

/**
 * Format a v3 QCResult as a brief Slack message suitable for a thread
 * reply. Keeps it terse — full QC details belong in the report card,
 * not the chat.
 */
export function formatLightQCResult(result: QCResult): string {
  const lines: string[] = [];
  lines.push(`*QC: ${result.grade}*`);
  lines.push('');
  lines.push(result.summary || result.overallAssessment);

  if (result.criticalIssues.length > 0) {
    lines.push('');
    lines.push('*Critical issues:*');
    for (const issue of result.criticalIssues.slice(0, 5)) {
      lines.push(`• ${issue.issue}${issue.suggestedFix ? ` → ${issue.suggestedFix}` : ''}`);
    }
    if (result.criticalIssues.length > 5) {
      lines.push(`_+ ${result.criticalIssues.length - 5} more — ask for the full report_`);
    }
  }

  if (result.criticalIssues.length === 0 && result.importantIssues.length > 0) {
    lines.push('');
    lines.push('*Worth checking:*');
    for (const issue of result.importantIssues.slice(0, 3)) {
      lines.push(`• ${issue.issue}`);
    }
  }

  if (['C', 'D', 'F'].includes(result.grade)) {
    lines.push('');
    lines.push('_Before submitting to marketing, consider workshopping your copy with <https://www.notion.so/ai|Notion AI> (sign in with your Pearl Google account) — then @Sage to file a review request._');
  }

  return lines.join('\n');
}

export interface LightQCInput {
  text: string;
  threadTs: string;
  say: (params: { text: string; thread_ts?: string }) => Promise<unknown>;
}

export type LightQCOutcome = 'qc_returned' | 'routed_to_modal' | 'no_content';

/**
 * Run light QC on a v2 channel mention. Returns an outcome indicator
 * so the caller can log the right event type.
 */
export async function handleLightQC(input: LightQCInput): Promise<LightQCOutcome> {
  const { text, threadTs, say } = input;

  if (isPubBound(text)) {
    await say({
      text:
        "Sounds like this is going out — let me route it through marketing triage instead of self-service QC. " +
        '_(Modal flow lands in US-009; for now, file a request via @Sage and tag it as needing review.)_',
      thread_ts: threadTs,
    });
    return 'routed_to_modal';
  }

  // Google Doc URL — fetch content and QC it
  const docUrl = extractGoogleDocUrl(text);
  if (docUrl) {
    await say({ text: ':mag: Reading your Google Doc...', thread_ts: threadTs });
    try {
      const { title, content } = await readGoogleDoc(docUrl);
      if (!content || content.length < 10) {
        await say({
          text: "I could open the document but it appears to be empty. Make sure it has text content and try again.",
          thread_ts: threadTs,
        });
        return 'no_content';
      }
      const result = await runQC(content, title);
      const body = formatLightQCResult(result);
      await say({ text: withDisclaimer(`*${title}*\n\n${body}`), thread_ts: threadTs });
      return 'qc_returned';
    } catch (err: any) {
      await say({
        text: `I wasn't able to read that document. ${err.message ?? 'Please make sure it\'s shared and try again.'}`,
        thread_ts: threadTs,
      });
      return 'no_content';
    }
  }

  // Pasted text
  const content = extractQCContent(text);
  if (!content || content.length < 10) {
    await say({
      text: "Paste the copy you'd like me to check — or share a Google Doc link — and I'll run it against the brand guidelines.",
      thread_ts: threadTs,
    });
    return 'no_content';
  }

  const result = await runQC(content);
  const body = formatLightQCResult(result);
  await say({ text: withDisclaimer(body), thread_ts: threadTs });
  return 'qc_returned';
}
