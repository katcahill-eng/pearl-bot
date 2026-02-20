import 'dotenv/config';
import { config } from './lib/config';
import { App, LogLevel } from '@slack/bolt';
import { registerMentionHandler } from './handlers/mentions';
import { registerMessageHandler } from './handlers/messages';
import { registerApprovalHandler } from './handlers/approval';
import { registerPostSubmissionActions } from './handlers/intake';
import { checkTimeouts } from './handlers/timeout';
import { startWebhookServer } from './lib/webhook';
import { initDb, getInstanceId, logError, cleanOldErrors, cleanOldMetrics } from './lib/db';
import { trackError } from './lib/error-tracker';
import { runSelfAnalysis } from './lib/self-analysis';
import { sendDailyDigest } from './lib/daily-digest';

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
  await trackError(error, app.client, { source: 'bolt' });
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
const ERROR_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  console.log(`⚡ MarcomsBot is running in socket mode (BUILD 2026-02-20T0700 — haiku45-model-fix) instance=${getInstanceId().substring(0, 8)}`);

  // Start periodic timeout check
  setInterval(() => {
    checkTimeouts(app.client).catch((err) => {
      console.error('[timeout] Scheduled timeout check failed:', err);
      trackError(err, app.client, { source: 'timeout-check' });
    });
  }, TIMEOUT_CHECK_INTERVAL_MS);

  // Clean up old error logs daily
  setInterval(() => {
    cleanOldErrors(7).catch((err) => {
      console.error('[error-tracker] Cleanup failed:', err);
    });
  }, ERROR_CLEANUP_INTERVAL_MS);

  // Self-analysis: 5-minute delay (skip deploy churn), then every 24 hours
  setTimeout(() => {
    runSelfAnalysis().catch((err) => console.error('[self-analysis] Initial run failed:', err));
    setInterval(() => {
      runSelfAnalysis().catch((err) => console.error('[self-analysis] Scheduled run failed:', err));
    }, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Daily digest: check every 60s if it's 9:00am ET, send once per day
  let lastDigestDate = '';
  setInterval(() => {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const todayStr = et.toISOString().split('T')[0];
    if (et.getHours() === 9 && et.getMinutes() === 0 && lastDigestDate !== todayStr) {
      lastDigestDate = todayStr;
      sendDailyDigest(app.client).catch((err) => {
        console.error('[daily-digest] Failed to send digest:', err);
        trackError(err, app.client, { source: 'daily-digest' });
      });
    }
  }, 60_000);

  // Start webhook HTTP server for form submissions
  startWebhookServer({ port: config.webhookPort, slackClient: app.client });
})().catch((err) => {
  console.error('[fatal] Startup failed:', err);
  process.exit(1);
});
