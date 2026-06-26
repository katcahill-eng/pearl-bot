/**
 * Slack delivery — posts the weekly drop to the marketing-staff-only channel
 * with the analyst's take and links to the deck + data Sheet. The board-facing
 * detail lives in the deck; Slack is the nudge + headline.
 */

import { WebClient } from '@slack/web-api';
import { ciConfig } from '../config';
import type { MaterialEvent, WeeklySynthesis } from '../types';

const slack = new WebClient(ciConfig.slackBotToken);

const CATEGORY_EMOJI: Record<string, string> = {
  funding: '💰',
  'm&a': '🤝',
  product: '🚀',
  pricing: '🏷️',
  partnership: '🤝',
  coverage: '📰',
  'ai-visibility': '🔎',
  ranking: '📈',
  other: '•',
};

/**
 * Daily pulse: post lightweight heads-up alerts for newly-detected material
 * events. One compact message; nothing posts if `events` is empty (caller guards).
 */
export async function postAlerts(events: MaterialEvent[]): Promise<void> {
  if (!events.length) return;
  const lines = events.map((e) => {
    const emoji = CATEGORY_EMOJI[e.category] ?? '•';
    const src = e.source?.startsWith('http') ? ` <${e.source}|source>` : '';
    return `${emoji} *${e.competitor}* — ${e.headline}\n     _why it matters:_ ${e.why}${src}`;
  });

  await slack.chat.postMessage({
    channel: ciConfig.slackChannelId,
    text: `Competitor heads-up: ${events.length} new development(s)`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚡ *Competitor heads-up* — ${events.length} new development${events.length > 1 ? 's' : ''} since last check:`,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n\n') } },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Full analysis lands in Monday’s briefing.' }],
      },
    ],
  });
}

export async function postWeekly(
  synthesis: WeeklySynthesis,
  links: { deckUrl: string; sheetUrl: string },
  runDate: string,
): Promise<void> {
  const bullets = (arr: string[]) =>
    arr.length ? arr.map((x) => `• ${x}`).join('\n') : '_None this week._';

  const blocks: any[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🛰️ Competitor Intel — week of ${runDate}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*The one thing:*\n${synthesis.analystTake || '_No take generated._'}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*What moved*\n${bullets(synthesis.movements)}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Where we can take ground*\n${bullets(synthesis.opportunities)}` },
    },
  ];

  if (synthesis.threats.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Threats to watch*\n${bullets(synthesis.threats)}` },
    });
  }
  if (synthesis.suggestedAdditions.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*Suggested to add to watchlist* (your call)\n` +
          synthesis.suggestedAdditions.map((p) => `• *${p.name}* — ${p.reason}`).join('\n'),
      },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `<${links.deckUrl}|📊 Board deck>  ·  <${links.sheetUrl}|📈 Data sheet>` },
    ],
  });

  await slack.chat.postMessage({
    channel: ciConfig.slackChannelId,
    text: `Competitor Intel — week of ${runDate}: ${synthesis.analystTake}`.slice(0, 280),
    blocks,
  });
}
