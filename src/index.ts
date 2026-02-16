import 'dotenv/config';
import { config } from './lib/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mentions';
import { registerMessageHandler } from './handlers/messages';
import { registerApprovalHandler } from './handlers/approval';
import { registerPostSubmissionActions } from './handlers/intake';
import { checkTimeouts } from './handlers/timeout';
import { startWebhookServer } from './lib/webhook';
import { initDb, getInstanceId } from './lib/db';

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

// Global event middleware — logs ALL incoming events before any handler runs.
app.use(async ({ body, next }) => {
  const event = (body as any).event;
  if (event) {
    const type = event.type ?? 'unknown';
    const subtype = event.subtype ?? '';
    const user = event.user ?? '';
    const ts = event.ts ?? '';
    const threadTs = event.thread_ts ?? '';
    const text = (event.text ?? '').substring(0, 60);
    console.log(`[bolt-event] type=${type} subtype=${subtype} user=${user} ts=${ts} thread_ts=${threadTs} text="${text}" instance=${getInstanceId().substring(0, 8)}`);
  }
  await next();
});

registerMentionHandler(app);
registerMessageHandler(app);
registerApprovalHandler(app);
registerPostSubmissionActions(app);

const TIMEOUT_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Graceful shutdown — disconnect from Slack so events stop being routed to this instance.
// Critical for rolling deploys: without this, Slack splits events between old and new instances.
process.on('SIGTERM', async () => {
  console.log('[shutdown] SIGTERM received, disconnecting from Slack...');
  try {
    await app.stop();
    console.log('[shutdown] Disconnected from Slack. Exiting.');
  } catch (err) {
    console.error('[shutdown] Error stopping app:', err);
  }
  process.exit(0);
});

(async () => {
  await initDb();
  await app.start();
  console.log(`⚡ MarcomsBot is running in socket mode (BUILD 2026-02-16T0300 — strategic-idk+clarification) instance=${getInstanceId().substring(0, 8)}`);

  // Start periodic timeout check
  setInterval(() => {
    checkTimeouts(app.client).catch((err) => {
      console.error('[timeout] Scheduled timeout check failed:', err);
    });
  }, TIMEOUT_CHECK_INTERVAL_MS);

  // Start webhook HTTP server for form submissions
  startWebhookServer({ port: config.webhookPort, slackClient: app.client });
})();
