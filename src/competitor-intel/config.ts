/**
 * Competitor Intelligence spoke — configuration.
 *
 * Reuses Sage's shared credentials (Anthropic, Google service account, Slack)
 * via the main config, and adds spoke-specific env vars. These are read
 * directly from process.env (NOT added to the bot's required-var validation)
 * so the spoke can be deployed independently without breaking Sage startup.
 *
 * Required for the spoke to run (set as Railway secrets):
 *   SEMRUSH_API_KEY                  - SEMrush Analytics API key
 *   PERPLEXITY_API_KEY               - Perplexity API key (research engine)
 *   COMPETITOR_INTEL_FOLDER_ID       - Drive folder for the Sheet + Slides
 *   COMPETITOR_INTEL_SLACK_CHANNEL_ID- marketing-staff-only channel for delivery
 *
 * Optional:
 *   COMPETITOR_INTEL_SHEET_ID        - existing data Sheet (auto-created if absent)
 *   COMPETITOR_INTEL_DECK_ID         - existing Slides deck (auto-created if absent)
 *   COMPETITOR_INTEL_MODEL           - Claude model for synthesis
 *   GEMINI_API_KEY                   - optional second AI-visibility engine (Phase 2)
 */

import { config as base } from '../lib/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `[competitor-intel] Missing required env var ${name}. ` +
        `Set it as a Railway secret before running the spoke.`,
    );
  }
  return v;
}

export const ciConfig = {
  // Reused from Sage
  anthropicApiKey: base.anthropicApiKey,
  googleServiceAccountJson: base.googleServiceAccountJson,
  slackBotToken: base.slackBotToken,

  // Spoke-specific (lazy-validated in run.ts so importing this file is safe)
  get semrushApiKey() {
    return required('SEMRUSH_API_KEY');
  },
  get perplexityApiKey() {
    return required('PERPLEXITY_API_KEY');
  },
  get folderId() {
    return required('COMPETITOR_INTEL_FOLDER_ID');
  },
  get slackChannelId() {
    return required('COMPETITOR_INTEL_SLACK_CHANNEL_ID');
  },

  // Optional
  sheetId: process.env.COMPETITOR_INTEL_SHEET_ID ?? '',
  deckId: process.env.COMPETITOR_INTEL_DECK_ID ?? '',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',

  // Synthesis model — defaults to the Sonnet Sage already uses; bump to
  // claude-opus-4-8 here (or via env) for higher-grade board synthesis.
  model: process.env.COMPETITOR_INTEL_MODEL ?? 'claude-sonnet-4-20250514',

  // SEMrush database (geo) for analytics calls
  semrushDatabase: process.env.SEMRUSH_DATABASE ?? 'us',
} as const;
