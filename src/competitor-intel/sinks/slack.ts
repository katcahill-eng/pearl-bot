/**
 * Slack delivery — posts the weekly drop to the marketing-staff-only channel
 * with the analyst's take and links to the deck + data Sheet. The board-facing
 * detail lives in the deck; Slack is the nudge + headline.
 */

import { WebClient } from '@slack/web-api';
import { ciConfig } from '../config';
import type { WeeklySynthesis } from '../types';

const slack = new WebClient(ciConfig.slackBotToken);

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
