/**
 * Sage v2 modal pre-fill parser + opener.
 *
 * Slack `app_mention` events don't carry a trigger_id, so we can't open
 * a modal directly. Instead the channel router (US-005) calls
 * postOpenModalButton, which posts a thread reply with an "Open request
 * form" button. When the user clicks it, Slack fires a block_actions
 * event WITH a trigger_id; the registered action handler then parses
 * the original text, computes recommendations, and opens the modal —
 * all within the 3-second trigger_id budget.
 *
 * The original mention text + channel/thread metadata is encoded into
 * the button's value so we don't need server-side state between the
 * mention and the click.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { App } from '@slack/bolt';
import type { Division } from '../lib/division-lookup';
import {
  matchRecommendations,
  type ParsedRequest,
  type Recommendation,
} from '../lib/director-rules';
import { logRequestEvent } from '../lib/event-log';
import {
  buildRequestModal,
  emailPolicyBlock,
  rushBannerBlock,
  scheduleCallBlock,
  REQUEST_TYPE_ACTION_ID,
  DEADLINE_ACTION_ID,
  LIVE_DATE_ACTION_ID,
  EMAIL_POLICY_BLOCK_ID,
  RUSH_BANNER_BLOCK_ID,
  SCHEDULE_CALL_BLOCK_ID,
} from '../lib/modals/request-modal';

// Lazy-initialize the client so unit tests that mock @anthropic-ai/sdk
// can patch it before construction.
let _sonnetClient: Anthropic | null = null;
function sonnetClient(): Anthropic {
  if (!_sonnetClient) _sonnetClient = new Anthropic({ timeout: 2_500 });
  return _sonnetClient;
}

const PARSE_SYSTEM_PROMPT = `You extract structured fields from a Slack user's plain-language description of a marketing request.

Respond ONLY with a JSON object matching this exact schema (no markdown, no explanation):

{
  "requestType":   string | null,   // e.g. "webinar", "email", "graphic", "campaign", "blog", "presentation"
  "deliverable":   string | null,   // a 1-2 sentence description of what they're asking for
  "audience":      string | null,   // who the deliverable targets — extract phrases like "for X", "to X", "targeting X" (e.g. "real estate agents", "homeowners", "BD partners"). IMPORTANT: social media platform names (LinkedIn, Instagram, Facebook, X, Twitter, BlueSky, YouTube) are NOT audiences — they are distribution channels. If "for LinkedIn" is the only "for X" phrase, set audience to null and include the platform in the deliverable instead.
  "deadline":      string | null,   // ISO-8601 (YYYY-MM-DD) if a date is given, null otherwise
  "eventOrProject": string | null,  // event/project name if mentioned (e.g. "NAR Houston", "Pearl Pro launch")
  "additionalDivisionsImpacted": string[] | null  // any of: BD, P2, CX/Core, Corporate, Product, Marketing
}

CRITICAL: requestType is the TYPE OF DELIVERABLE marketing is being asked to BUILD, not the surrounding context. A "registration email for a webinar" is requestType: "email" (the email is the deliverable; the webinar is the eventOrProject context). Same for "social posts about a product launch" → "social_media", not "product_launch".

Examples:
"I need a registration email for the May 12 webinar — for real estate agents"
  → { "requestType": "email", "deliverable": "Registration email", "audience": "real estate agents", "deadline": null, "eventOrProject": "May 12 webinar", "additionalDivisionsImpacted": null }

"Help us run a webinar on May 12 for real estate agents"
  → { "requestType": "webinar", "deliverable": "Webinar on May 12", "audience": "real estate agents", "deadline": null, "eventOrProject": null, "additionalDivisionsImpacted": null }

"Help us build a one-pager about Pearl SCORE for homeowners"
  → { "requestType": "document", "deliverable": "One-pager about Pearl SCORE", "audience": "homeowners", "deadline": null, "eventOrProject": null, "additionalDivisionsImpacted": null }

"Press release for the Pearl Pro launch in June"
  → { "requestType": "press_release", "deliverable": "Press release announcing Pearl Pro", "audience": null, "deadline": null, "eventOrProject": "Pearl Pro launch", "additionalDivisionsImpacted": null }

"I need a social post for LinkedIn"
  → { "requestType": "social_media", "deliverable": "Social media post for LinkedIn", "audience": null, "deadline": null, "eventOrProject": null, "additionalDivisionsImpacted": null }

If a field is not mentioned or cannot be confidently extracted, set it to null.`;

const VALID_DIVISIONS: Division[] = [
  'BD',
  'P2',
  'CX/Core',
  'Corporate',
  'Product',
  'Marketing',
];

export const OPEN_MODAL_ACTION_ID = 'sage_v2_open_request_modal';

export type ParsedIntake = ParsedRequest & {
  additionalDivisionsImpacted?: Division[] | null;
  deadline?: string | null;
};

interface ButtonValue {
  text: string;
  channelId: string;
  threadTs: string;
}

/**
 * Parse plain-language @mention text into ParsedRequest fields via
 * Claude Sonnet. On parse failure (timeout / JSON error), returns a
 * fallback that puts the user's text in the deliverable field.
 */
export async function parseIntakeText(text: string): Promise<ParsedIntake> {
  const cleaned = text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
  if (!cleaned) return { deliverable: null };

  try {
    const response = await sonnetClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: PARSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: cleaned }],
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(stripped);

    return {
      requestType: typeof parsed.requestType === 'string' ? parsed.requestType : null,
      deliverable: typeof parsed.deliverable === 'string' ? parsed.deliverable : cleaned,
      audience:
        typeof parsed.audience === 'string' && parsed.audience.trim()
          ? parsed.audience
          : extractAudienceFallback(cleaned),
      eventOrProject:
        typeof parsed.eventOrProject === 'string' ? parsed.eventOrProject : null,
      additionalDivisionsImpacted: filterDivisions(parsed.additionalDivisionsImpacted),
      deadline: typeof parsed.deadline === 'string' ? parsed.deadline : null,
    };
  } catch (err) {
    console.error('[intake-modal] Parse failed, falling back:', err);
    return {
      deliverable: cleaned,
      audience: extractAudienceFallback(cleaned),
    };
  }
}

const SOCIAL_PLATFORMS = /^(linkedin|instagram|facebook|x|twitter|bluesky|youtube|tiktok|threads|pinterest)$/i;

/**
 * Regex fallback when Sonnet misses the audience. Matches common
 * "for X" / "to X" / "targeting X" phrases at the end of the text.
 */
export function extractAudienceFallback(text: string): string | null {
  // Try "for X" at end (most common Pearl phrasing)
  const forMatch = text.match(/\bfor\s+([a-z][\w\s/,&'-]{2,60})$/i);
  if (forMatch) {
    const candidate = forMatch[1].trim().replace(/[.!?]+$/, '');
    if (SOCIAL_PLATFORMS.test(candidate)) return null;
    return candidate;
  }

  // Try "targeting X"
  const targetMatch = text.match(/\btargeting\s+([a-z][\w\s/,&'-]{2,60})/i);
  if (targetMatch) return targetMatch[1].trim().replace(/[.!?]+$/, '');

  // Try "to X" at end (riskier — only if X looks like a group)
  const toMatch = text.match(/\bto\s+(real\s+estate\s+agents?|homeowners?|partners?|agents?|sellers?|buyers?|builders?|inspectors?|appraisers?|lenders?)\b/i);
  if (toMatch) return toMatch[1].trim();

  return null;
}

function filterDivisions(input: unknown): Division[] | null {
  if (!Array.isArray(input)) return null;
  const out = input.filter((d): d is Division =>
    typeof d === 'string' && (VALID_DIVISIONS as string[]).includes(d),
  );
  return out.length > 0 ? out : null;
}

export interface PostOpenModalButtonInput {
  channelId: string;
  threadTs: string;
  text: string;
  say: (params: {
    text: string;
    blocks?: any[];
    thread_ts?: string;
  }) => Promise<unknown>;
}

/**
 * Post a thread reply with an "Open request form" button. Called from
 * channel-router on a work_request intent.
 *
 * Per Kat 2026-05-06: this upstream message is for welcoming the
 * requester and prompting them into the form. Policy banners (email,
 * presentation, etc.) live IN the form and the confirmation reply,
 * not here. Keep this short and friendly.
 */
export async function postOpenModalButton(
  input: PostOpenModalButtonInput & { channelDivision?: string | null },
): Promise<void> {
  const { channelId, threadTs, text, say } = input;
  const value: ButtonValue = { text, channelId, threadTs };

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "Got it — click below to fill in a few details and I'll take it from there.",
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: OPEN_MODAL_ACTION_ID,
          text: { type: 'plain_text', text: 'Open request form' },
          style: 'primary',
          value: JSON.stringify(value).slice(0, 1900), // Slack 2000-char limit
        },
      ],
    },
  ];

  await say({
    text: 'Want to file this as a marketing request?',
    thread_ts: threadTs,
    blocks,
  });
}

/**
 * Register the open-modal button action handler. Wired in src/index.ts.
 * On click, parse the original text, compute recommendations, and open
 * the modal — all within Slack's 3-second trigger_id budget.
 */
export function registerOpenModalAction(app: App): void {
  app.action(OPEN_MODAL_ACTION_ID, async ({ ack, body, client }) => {
    await ack();

    try {
      const action = (body as any).actions?.[0];
      const triggerId = (body as any).trigger_id;
      const userId = (body as any).user?.id;
      if (!action?.value || !triggerId) return;

      const value: ButtonValue = JSON.parse(action.value);
      const metadata = { channelId: value.channelId, threadTs: value.threadTs };
      const cleaned = value.text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();

      // Open immediately with just the raw text so we don't burn the
      // 3-second trigger_id window waiting on Claude to parse.
      const emptyParsed: ParsedIntake = { deliverable: cleaned };
      const initialView = buildRequestModal(emptyParsed, [], metadata);
      const openResp = await client.views.open({ trigger_id: triggerId, view: initialView });
      const viewId = (openResp as any).view?.id as string | undefined;

      // Parse + recommendations run after the modal is already open,
      // then we push an update so the user sees pre-filled fields.
      parseIntakeText(value.text)
        .then(async (parsed) => {
          const recommendations: Recommendation[] = matchRecommendations(parsed);
          const updatedView = buildRequestModal(parsed, recommendations, metadata);
          if (viewId) {
            await client.views.update({ view_id: viewId, view: updatedView }).catch(() => {});
          }
          await logRequestEvent({
            eventType: 'modal_opened',
            userId,
            channelId: value.channelId,
            intent: 'work_request',
            parsedFields: parsed,
            recommendationsOffered: recommendations,
          });
        })
        .catch(() => {});
    } catch (err) {
      console.error('[intake-modal] open-modal action failed:', err);
    }
  });

  // When the user changes the Request Type dropdown, show or hide the
  // email-policy banner accordingly. This keeps the warning in front
  // of the user before they submit, not just at the start.
  app.action(REQUEST_TYPE_ACTION_ID, async ({ ack, body, client }) => {
    await ack();

    try {
      const view = (body as any).view;
      if (!view) return;

      const action = (body as any).actions?.[0];
      const newRequestType = action?.selected_option?.value as string | undefined;
      if (!newRequestType) return;

      let metadata: { channelId: string; threadTs: string };
      try {
        metadata = JSON.parse(view.private_metadata);
      } catch {
        return;
      }

      const newBanner = emailPolicyBlock(newRequestType, metadata.channelId);

      // Strip any existing banner block, then conditionally insert a
      // fresh one right after the request_type input.
      const filtered = (view.blocks ?? []).filter(
        (b: any) => b.block_id !== EMAIL_POLICY_BLOCK_ID,
      );

      if (newBanner) {
        const requestTypeIdx = filtered.findIndex(
          (b: any) => b.block_id === 'request_type',
        );
        if (requestTypeIdx >= 0) {
          filtered.splice(requestTypeIdx + 1, 0, newBanner);
        } else {
          filtered.unshift(newBanner);
        }
      }

      // Rebuild the draft_source block — required state and hint text
      // depend on the request type. Keep the same block_id so Slack
      // preserves any user-entered text.
      const { draftBlock } = await import('../lib/modals/request-modal');
      const newDraft = draftBlock(newRequestType);
      const draftIdx = filtered.findIndex(
        (b: any) => b.block_id === 'draft_source',
      );
      if (draftIdx >= 0) {
        filtered[draftIdx] = newDraft;
      }

      // Keep the contextual "Schedule a call" block in sync — it sits
      // right under the draft field, only when the request type has
      // a policy. Strip the old one and conditionally re-insert.
      const filteredWithoutSchedule = filtered.filter(
        (b: any) => b.block_id !== SCHEDULE_CALL_BLOCK_ID,
      );
      const newScheduleBlock = scheduleCallBlock(newRequestType);
      if (newScheduleBlock) {
        const newDraftIdx = filteredWithoutSchedule.findIndex(
          (b: any) => b.block_id === 'draft_source',
        );
        if (newDraftIdx >= 0) {
          filteredWithoutSchedule.splice(newDraftIdx + 1, 0, newScheduleBlock);
        }
      }
      filtered.length = 0;
      filtered.push(...filteredWithoutSchedule);

      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: {
          type: 'modal',
          callback_id: view.callback_id,
          private_metadata: view.private_metadata,
          title: view.title,
          submit: view.submit,
          close: view.close,
          blocks: filtered,
        },
      });
    } catch (err) {
      console.error('[intake-modal] request-type-change action failed:', err);
    }
  });

  // When the user picks (or changes) the Deadline or Live date, update
  // the form to show / hide the rush banner so they know upfront if
  // they're under Pearl's 2-week minimum.
  const handleDateChange = async ({ ack, body, client }: any): Promise<void> => {
    await ack();

    try {
      const view = body.view;
      if (!view) return;

      // Pull the most recent value of BOTH dates from the live form state.
      const deadline =
        view.state?.values?.deadline?.[DEADLINE_ACTION_ID]?.selected_date ?? null;
      const liveDate =
        view.state?.values?.live_date?.[LIVE_DATE_ACTION_ID]?.selected_date ?? null;

      const newBanner = rushBannerBlock(deadline, liveDate);

      // Strip any existing rush banner, then re-insert if needed —
      // right after the live_date input so it's adjacent to the dates.
      const filtered = (view.blocks ?? []).filter(
        (b: any) => b.block_id !== RUSH_BANNER_BLOCK_ID,
      );

      if (newBanner) {
        const liveDateIdx = filtered.findIndex(
          (b: any) => b.block_id === 'live_date',
        );
        const insertAt = liveDateIdx >= 0 ? liveDateIdx + 1 : filtered.length;
        filtered.splice(insertAt, 0, newBanner);
      }

      await client.views.update({
        view_id: view.id,
        hash: view.hash,
        view: {
          type: 'modal',
          callback_id: view.callback_id,
          private_metadata: view.private_metadata,
          title: view.title,
          submit: view.submit,
          close: view.close,
          blocks: filtered,
        },
      });
    } catch (err) {
      console.error('[intake-modal] date-change action failed:', err);
    }
  };

  app.action(DEADLINE_ACTION_ID, handleDateChange);
  app.action(LIVE_DATE_ACTION_ID, handleDateChange);
}
