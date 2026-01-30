/**
 * Configuration module — loads and validates all environment variables on startup.
 * If any required variable is missing, the process exits with a clear error.
 */

const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_MARKETING_CHANNEL_ID',
  'ANTHROPIC_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_PROJECTS_FOLDER_ID',
  'MONDAY_API_TOKEN',
  'MONDAY_QUICK_BOARD_ID',
  'MONDAY_FULL_BOARD_ID',
  'MARKETING_LEAD_SLACK_ID',
] as const;

function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    for (const key of missing) {
      console.error(`   - ${key}`);
    }
    console.error('\nSee .env.example for reference.');
    process.exit(1);
  }
}

validateEnv();

export const config = {
  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN!,
  slackAppToken: process.env.SLACK_APP_TOKEN!,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET!,
  slackMarketingChannelId: process.env.SLACK_MARKETING_CHANNEL_ID!,

  // Slack — marketing lead receives triage DMs for new requests
  marketingLeadSlackId: process.env.MARKETING_LEAD_SLACK_ID!,

  // Slack — optional separate notification channel (defaults to marketing channel)
  slackNotificationChannelId: process.env.SLACK_NOTIFICATION_CHANNEL_ID || process.env.SLACK_MARKETING_CHANNEL_ID!,

  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,

  // Google Drive
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON!,
  googleProjectsFolderId: process.env.GOOGLE_PROJECTS_FOLDER_ID!,

  // Monday.com
  mondayApiToken: process.env.MONDAY_API_TOKEN!,
  mondayQuickBoardId: process.env.MONDAY_QUICK_BOARD_ID!,
  mondayFullBoardId: process.env.MONDAY_FULL_BOARD_ID!,

  // Optional
  intakeFormUrl: process.env.INTAKE_FORM_URL ?? '',
  marketingLeadCalendarUrl: process.env.MARKETING_LEAD_CALENDAR_URL ?? '',
  webhookPort: parseInt(process.env.WEBHOOK_PORT ?? '3100', 10),
} as const;

export type Config = typeof config;
