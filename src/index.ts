import 'dotenv/config';
import { config } from './lib/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mentions';
import { registerMessageHandler } from './handlers/messages';
import { registerApprovalHandler } from './handlers/approval';
import { registerPostSubmissionActions } from './handlers/intake';
import { checkTimeouts } from './handlers/timeout';
import { startWebhookServer } from './lib/webhook';
import { initDb } from './lib/db';

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  signingSecret: config.slackSigningSecret,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// Global error handler — catches any unhandled errors from Bolt event processing
app.error(async (error) => {
  console.error('[bolt] Unhandled error in Bolt event processing:', error);
});

registerMentionHandler(app);
registerMessageHandler(app);
registerApprovalHandler(app);
registerPostSubmissionActions(app);

const TIMEOUT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

(async () => {
  await initDb();
  await app.start();
  console.log('⚡ MarcomsBot is running in socket mode (v3 — knowledge base, follow-ups, post-submission)');

  // Start periodic timeout check
  setInterval(() => {
    checkTimeouts(app.client).catch((err) => {
      console.error('[timeout] Scheduled timeout check failed:', err);
    });
  }, TIMEOUT_CHECK_INTERVAL_MS);

  // Start webhook HTTP server for form submissions
  startWebhookServer({ port: config.webhookPort, slackClient: app.client });
})();
