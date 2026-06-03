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
import { OPEN_MODAL_ACTION_ID } from './intake-modal';

const GOOGLE_DOC_PATTERN = /https?:\/\/docs\.google\.com\/document\/d\/[a-zA-Z0-9_\-/]+/;

function extractGoogleDocUrl(text: string): string | null {
  const match = text.match(GOOGLE_DOC_PATTERN);
  return match ? match[0] : null;
}

const QC_INTENT_KEYWORDS = /\b(qc|quality[\s-]check|brand[\s-](check|review)|is\s+this\s+(on[\s-]?brand|good)|check\s+(this|it)\s+against|on[\s-]?brand)\b/i;

export const QC_DOC_ACTION_ID = 'qc_doc_url';
export const REVIEW_DOC_ACTION_ID = 'review_doc_url';
export const REPORT_DOC_ERROR_ACTION_ID = 'report_doc_error';

export function buildDocErrorBlocks(params: {
  docUrl: string;
  userId: string;
  channelId: string;
  threadTs: string;
  errorSummary: string;
  retryActionId?: string;
}): any[] {
  const retryActionId = params.retryActionId ?? QC_DOC_ACTION_ID;
  const payload = JSON.stringify({
    u: params.userId,
    d: params.docUrl.substring(0, 300),
    e: params.errorSummary.substring(0, 150),
    c: params.channelId,
    t: params.threadTs,
  });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: params.errorSummary.startsWith("This document isn't accessible")
        ? params.errorSummary
        : "I wasn't able to access that document. In Google Docs, go to Share and set General Access to \"Anyone with the link\" (Viewer), then try again.",
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Try again' },
          action_id: retryActionId,
          value: params.docUrl,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Report issue to marketing' },
          action_id: REPORT_DOC_ERROR_ACTION_ID,
          value: payload,
        },
      ],
    },
  ];
}

/**
 * True when the message is essentially just a Google Doc URL with no
 * indication of what the user wants done with it.
 */
function isBareDocUrl(text: string): boolean {
  const withoutMention = text.replace(/^<@[A-Z0-9]+>\s*/, '');
  if (QC_INTENT_KEYWORDS.test(withoutMention)) return false;
  const withoutUrl = withoutMention.replace(GOOGLE_DOC_PATTERN, '').trim();
  return withoutUrl.length < 20;
}

/**
 * True when the user's message signals the content is destined for a
 * public Pearl channel: social media, press release, or web/website.
 * These are the only content types that require a formal marketing review.
 */
const PUBLIC_CHANNEL_PATTERNS: RegExp[] = [
  /\bsocial\s*(media|post|content)?\b/i,
  /\blinkedin\b/i,
  /\btwitter\b/i,
  /\binstagram\b/i,
  /\bfacebook\b/i,
  /\bblueski?y\b/i,
  /\bpress\s*release\b/i,
  /\bmedia\s*release\b/i,
  /\b(for\s+)?(the\s+)?(web(site)?|web\s*(page|copy)|landing\s*page|site\s*copy)\b/i,
  /\bblog\s*post\b/i,
  /\bfor\s+publication\b/i,
  /\bpublic[\s-]facing\b/i,
];

export function isPublicChannelContent(text: string): boolean {
  return PUBLIC_CHANNEL_PATTERNS.some((re) => re.test(text));
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
    .replace(/^(is\s+this\s+(on[\s-]?brand|good)|brand\s+(check|review)|qc\s+this|qc[\s:,]|review[\s:,]|check\s+this[\s:,]?|check\s+(this|it)\s+against\s+\S+)\s*[:,]?\s*/i, '')
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
      lines.push(`• ${issue.issue}${issue.suggestedFix ? ` → ${issue.suggestedFix}` : ''}`);
    }
  }

  if (result.criticalIssues.length === 0 && result.importantIssues.length === 0 && result.minorIssues.length > 0) {
    lines.push('');
    lines.push('*Minor suggestions:*');
    for (const issue of result.minorIssues.slice(0, 3)) {
      lines.push(`• ${issue.issue}${issue.suggestedFix ? ` → ${issue.suggestedFix}` : ''}`);
    }
  }

  if (['C', 'D', 'F'].includes(result.grade)) {
    lines.push('');
    lines.push('_Before submitting to marketing, consider workshopping your copy with <https://www.notion.so/ai|Notion AI> (sign in with your Pearl Google account) — then @Sage to file a review request._');
  }

  lines.push('');
  lines.push('---');
  lines.push('_*Grade guide:* A = publish-ready | B = fix issues above, try again | C/D/F = needs major revision_');
  lines.push('_*Who approves what:* Social posts, press releases, and web copy need a grade A + marketing sign-off before they go out. Content meant for internal or customer outreach is division-owned — this QC feedback is your guide, no marketing review needed._');

  return lines.join('\n');
}

export interface LightQCInput {
  text: string;
  threadTs: string;
  userId?: string;
  channelId?: string;
  say: (params: { text?: string; blocks?: any[]; thread_ts?: string }) => Promise<unknown>;
}

export type LightQCOutcome = 'qc_returned' | 'routed_to_modal' | 'no_content';

/**
 * Run light QC on a v2 channel mention. Returns an outcome indicator
 * so the caller can log the right event type.
 */
/**
 * After posting a QC result, optionally prompt for a formal marketing review.
 * Only fires when the user's message signals public-channel content
 * (social, press release, web). Grade A → submit button. Grade B–F →
 * tell them to revise to A first.
 */
async function postReviewPrompt(params: {
  result: QCResult;
  docUrl: string | null;
  text: string;
  threadTs: string;
  say: (p: { text?: string; blocks?: any[]; thread_ts?: string }) => Promise<unknown>;
}): Promise<void> {
  const { result, docUrl, text, threadTs, say } = params;
  if (!isPublicChannelContent(text)) return;

  if (result.grade === 'A') {
    await say({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: "Grade A — this is ready for a formal marketing review before it goes out. Want to submit it?",
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Submit for marketing review' },
              action_id: docUrl ? REVIEW_DOC_ACTION_ID : OPEN_MODAL_ACTION_ID,
              value: docUrl ?? 'open',
            },
          ],
        },
      ],
      thread_ts: threadTs,
    });
  } else {
    await say({
      text: `_Marketing requires a grade A before formal review. Work through the suggestions above, revise your copy, and @Sage again when you're ready._`,
      thread_ts: threadTs,
    });
  }
}

export async function handleLightQC(input: LightQCInput): Promise<LightQCOutcome> {
  const { text, threadTs, say, userId = '', channelId = '' } = input;

  if (isPubBound(text)) {
    await say({
      text:
        "Sounds like this is going out — let me route it through marketing triage instead of self-service QC. " +
        '_(Modal flow lands in US-009; for now, file a request via @Sage and tag it as needing review.)_',
      thread_ts: threadTs,
    });
    return 'routed_to_modal';
  }

  // Google Doc URL
  const docUrl = extractGoogleDocUrl(text);
  if (docUrl) {
    // Bare URL with no intent — ask what they want
    if (isBareDocUrl(text)) {
      await say({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "I see you've shared a Google Doc. What would you like me to do with it?",
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Check it against brand guidelines' },
                action_id: QC_DOC_ACTION_ID,
                value: docUrl,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Submit for marketing review' },
                action_id: REVIEW_DOC_ACTION_ID,
                value: docUrl,
              },
            ],
          },
        ],
        thread_ts: threadTs,
      });
      return 'no_content';
    }

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
      await postReviewPrompt({ result, docUrl, text, threadTs, say });
      return 'qc_returned';
    } catch (err: any) {
      const errorSummary = err.message ?? 'unknown error';
      await say({
        blocks: buildDocErrorBlocks({ docUrl, userId, channelId, threadTs, errorSummary }),
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
  await postReviewPrompt({ result, docUrl: null, text, threadTs, say });
  return 'qc_returned';
}
