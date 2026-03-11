import type { App } from '@slack/bolt';
import { config } from '../lib/config';

function buildHomeBlocks(): any[] {
  const channelId = config.slackMarketingChannelId;

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'MarcomsBot',
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_Your marketing team\'s intake assistant_',
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Submit a Marketing Request*\nNeed help with a conference, webinar, email campaign, collateral, or anything else? I'll walk you through a few quick questions and get your request to the right people.\n\nHead to <#${channelId}> and tell me what you need.`,
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Review a Document*\nShare a link to something you'd like marketing to review for brand consistency, terminology, and positioning.\n\nHead to <#${channelId}> and say "review this doc" with your link.`,
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Brand Resources*\nQuick answers about Pearl\'s brand — no request needed.\n\n' +
          '\u2022 "What are our brand colors?"\n' +
          '\u2022 "Where are the logos?"\n' +
          '\u2022 "What\'s our brand font?"\n' +
          '\u2022 "Brand guidelines"\n' +
          '\u2022 "Slide template"',
      },
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Just head to <#${channelId}> and start typing — I'll pick it up automatically. Say hello to get started!`,
      },
    },
  ];
}

export function registerAppHomeHandler(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;

    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: buildHomeBlocks(),
      },
    });
  });
}
