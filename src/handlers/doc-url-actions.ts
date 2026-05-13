import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import {
  QC_DOC_ACTION_ID,
  REVIEW_DOC_ACTION_ID,
  REPORT_DOC_ERROR_ACTION_ID,
  formatLightQCResult,
  buildDocErrorBlocks,
} from './light-qc';
import { runQC } from '../lib/qc-runner';
import { readGoogleDoc, checkDocAccess } from '../lib/google-docs-reader';
import { withDisclaimer } from '../lib/disclaimer';
import { handleDocumentReviewMessage } from './document-review';
import { findChannelsByRole } from '../lib/division-lookup';
import { config } from '../lib/config';

export function registerDocUrlActions(app: App): void {
  app.action(QC_DOC_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    try {
      const action = (body as BlockAction).actions?.[0] as ButtonAction;
      const docUrl = action?.value;
      if (!docUrl) return;

      const channelId = (body as BlockAction).channel?.id ?? '';
      const threadTs = (body as BlockAction).message?.thread_ts ?? (body as BlockAction).message?.ts ?? '';
      const userId = (body as BlockAction).user?.id ?? '';

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: ':mag: Reading your Google Doc...',
      });

      try {
        const { title, content } = await readGoogleDoc(docUrl);
        if (!content || content.length < 10) {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'I could open the document but it appears to be empty. Make sure it has text content and try again.',
          });
          return;
        }
        const result = await runQC(content, title);
        const body_text = withDisclaimer(`*${title}*\n\n${formatLightQCResult(result)}`);
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: body_text });
      } catch (err: any) {
        const errorSummary = err.message ?? 'unknown error';
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildDocErrorBlocks({ docUrl, userId, channelId, threadTs, errorSummary }),
        });
      }
    } catch (err) {
      console.error('[doc-url-actions] qc_doc_url error:', err);
    }
  });

  app.action(REVIEW_DOC_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    try {
      const action = (body as BlockAction).actions?.[0] as ButtonAction;
      const docUrl = action?.value;
      if (!docUrl) return;

      const channelId = (body as BlockAction).channel?.id ?? '';
      const threadTs = (body as BlockAction).message?.thread_ts ?? (body as BlockAction).message?.ts ?? '';
      const userId = (body as BlockAction).user?.id ?? '';
      const userName = (body as BlockAction).user?.username ?? userId;

      const say = (params: { text?: string; blocks?: any[]; thread_ts?: string }) =>
        client.chat.postMessage({ channel: channelId, ...(params as any) });

      // Verify Sage can access the doc before starting intake — saves marketing
      // from receiving a task they can't action because the doc is private.
      try {
        await checkDocAccess(docUrl);
      } catch (err: any) {
        const errorSummary = err.message ?? 'unknown error';
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildDocErrorBlocks({
            docUrl,
            userId,
            channelId,
            threadTs,
            errorSummary,
            retryActionId: REVIEW_DOC_ACTION_ID,
          }),
        });
        return;
      }

      await handleDocumentReviewMessage({
        userId,
        userName,
        channelId,
        threadTs,
        text: docUrl,
        say: say as any,
        client,
      });
    } catch (err) {
      console.error('[doc-url-actions] review_doc_url error:', err);
    }
  });

  app.action(REPORT_DOC_ERROR_ACTION_ID, async ({ ack, body, client }) => {
    await ack();

    const action = (body as BlockAction).actions?.[0] as ButtonAction;
    let payload: any = {};
    try { payload = JSON.parse(action?.value ?? '{}'); } catch { /* malformed */ }

    const { u: userId, d: docUrl, e: errorDetail, c: payloadChannelId, t: payloadThreadTs } = payload;

    const replyChannelId = (body as BlockAction).channel?.id ?? payloadChannelId ?? '';
    const replyThreadTs =
      (body as BlockAction).message?.thread_ts ??
      (body as BlockAction).message?.ts ??
      payloadThreadTs ??
      '';

    // Always confirm to the user first so they get feedback regardless of what happens next.
    if (replyChannelId) {
      try {
        await client.chat.postMessage({
          channel: replyChannelId,
          thread_ts: replyThreadTs,
          text: "Thanks — I've flagged this for the marketing team to investigate.",
        });
      } catch (err) {
        console.error('[doc-url-actions] report_doc_error: failed to confirm to user:', err);
      }
    }

    // Post the structured bug report to the alerts channel.
    try {
      const alertChannels = findChannelsByRole('alerts');
      const reportChannel = alertChannels[0] ?? config.slackMarketingChannelId;
      console.log(`[doc-url-actions] Posting error report to channel: ${reportChannel}`);
      await client.chat.postMessage({
        channel: reportChannel,
        text: [
          ':bug: *Sage error report*',
          `• Reported by: ${userId ? `<@${userId}>` : '_unknown_'}`,
          '• Tried to: access a Google Doc',
          docUrl ? `• Doc: <${docUrl}|link>` : '',
          `• Error: \`${errorDetail || 'no details captured'}\``,
          replyChannelId ? `• Source: <#${replyChannelId}> thread \`${replyThreadTs}\`` : '',
        ].filter(Boolean).join('\n'),
      });
    } catch (err) {
      console.error('[doc-url-actions] report_doc_error: failed to post report to alerts channel:', err);
    }
  });
}
