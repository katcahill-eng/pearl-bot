import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { QC_DOC_ACTION_ID, REVIEW_DOC_ACTION_ID, formatLightQCResult } from './light-qc';
import { runQC } from '../lib/qc-runner';
import { readGoogleDoc } from '../lib/google-docs-reader';
import { withDisclaimer } from '../lib/disclaimer';
import { handleDocumentReviewMessage } from './document-review';

export function registerDocUrlActions(app: App): void {
  app.action(QC_DOC_ACTION_ID, async ({ ack, body, client }) => {
    await ack();
    try {
      const action = (body as BlockAction).actions?.[0] as ButtonAction;
      const docUrl = action?.value;
      if (!docUrl) return;

      const channelId = (body as BlockAction).channel?.id ?? '';
      const threadTs = (body as BlockAction).message?.thread_ts ?? (body as BlockAction).message?.ts ?? '';

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
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `I wasn't able to read that document. ${err.message ?? 'Please make sure it\'s shared and try again.'}`,
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
        client.chat.postMessage({ channel: channelId, ...params });

      await handleDocumentReviewMessage({
        userId,
        userName,
        channelId,
        threadTs,
        text: docUrl,
        say,
        client,
      });
    } catch (err) {
      console.error('[doc-url-actions] review_doc_url error:', err);
    }
  });
}
