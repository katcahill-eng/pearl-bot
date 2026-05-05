/**
 * AI-disclaimer helper for Sage v2.
 *
 * Every AI-authored response Sage sends to a user must carry the disclaimer
 * (per PRD FR-4). Monday-sourced facts and lifecycle replies are NOT
 * AI-authored and must NOT carry the disclaimer — pass them straight through.
 *
 * Use `withDisclaimer` for plain-text messages and `withDisclaimerBlocks`
 * for Block Kit messages (the disclaimer becomes a small context block
 * appended to the message).
 */

export const DISCLAIMER_TEXT =
  'This is AI-generated based on the most recent marketing resource documents. ' +
  'If human review is needed, @mention me to submit a request.';

/**
 * Append the disclaimer to a plain-text Slack message.
 * Italicizes the disclaimer using mrkdwn underscores so it visually
 * separates from the main reply.
 */
export function withDisclaimer(message: string): string {
  return `${message}\n\n_${DISCLAIMER_TEXT}_`;
}

/**
 * Append the disclaimer as a context block to a Block Kit message.
 * Returns a new array — does not mutate the caller's array.
 */
export function withDisclaimerBlocks(blocks: any[]): any[] {
  return [
    ...blocks,
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_${DISCLAIMER_TEXT}_`,
        },
      ],
    },
  ];
}
