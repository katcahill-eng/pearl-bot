/**
 * Sage v2 request modal schema.
 *
 * The modal users see when @Sage classifies a channel mention as a
 * work_request. Pre-filled from the parser (US-009) with optional
 * director-brain recommendation checkboxes (US-008).
 *
 * This file is the canonical source of truth for the modal's structure.
 * Per PRD US-010, the modal carries:
 *   - Request Type (static_select)
 *   - Deliverable (plain_text_input multiline)
 *   - Audience (plain_text_input)
 *   - Event/Project (plain_text_input optional)
 *   - Deadline (datepicker)
 *   - Approvals (multi_users_select)
 *   - Additional Divisions Impacted (multi_static_select; BD | P2 |
 *     CX/Core | Corporate | Product | Marketing)
 *   - Requesting for (users_select optional)
 *   - Recommendations (zero-to-many checkbox blocks; capped at 8)
 *
 * Filled out in US-010. For now, US-009 ships a minimal placeholder
 * so the parser + opener pipeline is testable end-to-end.
 */

import { divisionForChannel, type Division } from '../division-lookup';
import type { Recommendation, ParsedRequest } from '../director-rules';

export interface ModalMetadata {
  channelId: string;
  threadTs: string;
}

export const REQUEST_TYPE_ACTION_ID = 'sage_v2_request_type_change';
export const POLICY_BLOCK_ID = 'request_type_policy_banner';
// Kept exported for backward-compat with existing imports.
export const EMAIL_POLICY_BLOCK_ID = POLICY_BLOCK_ID;

const EMAIL_POLICY_TEXT =
  ":warning: *Heads up:* Each division owns its voice and audience. Divisions draft emails and Marketing reviews for brand alignment.";

const PRESENTATION_POLICY_TEXT =
  ":warning: *Heads up:* Provide a draft deck with your audience and key message already decided. Marketing refines the layout, graphics, and sequencing.";

const TALKING_POINTS_POLICY_TEXT =
  ":warning: *Heads up:* You will need to provide talking points (audience, goal, key info) before Marketing can start.";

const PRESS_RELEASE_POLICY_TEXT_DIVISION =
  ":warning: *Heads up:* If you need a press release written, the fee ($500–$2,000 depending on length) is charged back to your division's budget. If you already have a draft, just paste it in the draft field below and Marketing will take it from there.";

const PRESS_RELEASE_POLICY_TEXT_CORPORATE =
  ":warning: *Heads up:* Corporate messaging press release costs are covered by Marketing. If you already have a draft, just paste it in the draft field below and Marketing will take it from there.";

interface RequestTypePolicy {
  appliesTo: (channelDivision: string | null) => boolean;
  text: string;
  textForDivision?: (channelDivision: string | null) => string;
}

const WEBINAR_POLICY_TEXT =
  ":warning: *Heads up:* You will need to provide an agenda or talking points before Marketing can build registration assets.";

const REQUEST_TYPE_POLICIES: Record<string, RequestTypePolicy> = {
  email: {
    appliesTo: (d) => d !== 'Corporate',
    text: EMAIL_POLICY_TEXT,
  },
  presentation: {
    appliesTo: () => true,
    text: PRESENTATION_POLICY_TEXT,
  },
  webinar: {
    appliesTo: () => true,
    text: WEBINAR_POLICY_TEXT,
  },
  press_release: {
    appliesTo: () => true,
    text: PRESS_RELEASE_POLICY_TEXT_DIVISION,
    textForDivision: (d: string | null) =>
      d === 'Corporate' ? PRESS_RELEASE_POLICY_TEXT_CORPORATE : PRESS_RELEASE_POLICY_TEXT_DIVISION,
  },
  blog: {
    appliesTo: () => true,
    text: TALKING_POINTS_POLICY_TEXT,
  },
  landing_page: {
    appliesTo: () => true,
    text: TALKING_POINTS_POLICY_TEXT,
  },
  social_media: {
    appliesTo: () => true,
    text: TALKING_POINTS_POLICY_TEXT,
  },
  document: {
    appliesTo: () => true,
    text: TALKING_POINTS_POLICY_TEXT,
  },
};

/**
 * Resolve the policy text and Slack block for a given request type +
 * channel. Returns null if the request type has no policy, or if the
 * channel's division opts out of it (e.g., email in Corporate).
 *
 * Used by:
 *   - the modal initial render
 *   - the dispatch_action handler that re-renders when the user
 *     changes the Request Type select
 *   - the confirmation reply on submission
 */
export function requestTypePolicy(
  requestType: string | null,
  channelId: string,
): { block: any; text: string } | null {
  if (!requestType) return null;
  const policy = REQUEST_TYPE_POLICIES[requestType];
  if (!policy) return null;
  const division = divisionForChannel(channelId);
  if (!policy.appliesTo(division)) return null;
  const text = policy.textForDivision ? policy.textForDivision(division) : policy.text;
  return {
    block: {
      type: 'context',
      block_id: POLICY_BLOCK_ID,
      elements: [{ type: 'mrkdwn', text }],
    },
    text,
  };
}

/**
 * Convenience for callers that only need the Slack block
 * (modal renders / dispatch-action updates).
 */
export function emailPolicyBlock(
  requestType: string | null,
  channelId: string,
): any | null {
  return requestTypePolicy(requestType, channelId)?.block ?? null;
}

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'webinar', label: 'Webinar' },
  { value: 'email', label: 'Email' },
  { value: 'social_media', label: 'Social media' },
  { value: 'advertising', label: 'Advertising / paid ads' },
  { value: 'blog', label: 'Blog post' },
  { value: 'landing_page', label: 'New webpage' },
  { value: 'website_update', label: 'Website update' },
  { value: 'graphic', label: 'Graphic / design support' },
  { value: 'presentation', label: 'Presentation / deck' },
  { value: 'press_release', label: 'Press release' },
  { value: 'event', label: 'Event / trade show' },
  { value: 'ebook', label: 'Ebook / white paper' },
  { value: 'document', label: 'Document / one-pager' },
  { value: 'research', label: 'Research / analysis' },
  { value: 'other', label: 'Other' },
];

const DIVISION_OPTIONS: { value: Division; label: string }[] = [
  { value: 'BD', label: 'BD' },
  { value: 'P2', label: 'P2' },
  { value: 'CX/Core', label: 'CX/Core' },
  { value: 'Corporate', label: 'Corporate' },
  { value: 'Product', label: 'Product' },
  { value: 'Marketing', label: 'Marketing' },
];

const MAX_RECOMMENDATIONS = 8;

export const CALLBACK_ID = 'sage_v2_request_modal';
export const RUSH_BANNER_BLOCK_ID = 'rush_banner';
export const MIN_TURNAROUND_DAYS_FORM = 14;

/**
 * Returns the rush-banner block when the picked deadline (or live date
 * as fallback) is closer than Pearl's 2-week minimum.
 */
export function rushBannerBlock(
  deadline: string | null | undefined,
  liveDate: string | null | undefined,
  today: Date = new Date(),
): any | null {
  const target = deadline ?? liveDate;
  if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
  const targetDate = new Date(target + 'T00:00:00');
  const todayMidnight = new Date(today);
  todayMidnight.setHours(0, 0, 0, 0);
  const days = Math.round(
    (targetDate.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (days >= MIN_TURNAROUND_DAYS_FORM) return null;

  return {
    type: 'context',
    block_id: RUSH_BANNER_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text:
          `:warning: *Heads up: tight turnaround.* Marketing typically needs ~2 weeks (1 week to draft + 1 week for approvals and edits). ` +
          `Your timeline is ${days} day${days === 1 ? '' : 's'} from today. We'll review feasibility before committing — may need to adjust scope or timeline.`,
      },
    ],
  };
}

/**
 * Build a Slack view payload for the request modal, pre-filled from the
 * parser output and optionally augmented with director-brain
 * recommendations.
 */
export function buildRequestModal(
  parsed: ParsedRequest & { additionalDivisionsImpacted?: Division[] | null; deadline?: string | null; additionalDeliverables?: string[] | null },
  recommendations: Recommendation[],
  metadata: ModalMetadata,
): any {
  const blocks: any[] = [];

  blocks.push(
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Request details', emoji: true },
    },
    requestTypeBlock(parsed.requestType),
  );

  // Conditionally insert the email-policy banner right after Request Type.
  const policyBlock = emailPolicyBlock(parsed.requestType ?? null, metadata.channelId);
  if (policyBlock) {
    blocks.push(policyBlock);
  }

  blocks.push(
    additionalDeliverablesBlock(parsed.additionalDeliverables ?? null),
    deliverableBlock(parsed.deliverable),
    audienceBlock(parsed.audience),
    eventOrProjectBlock(parsed.eventOrProject),
    draftBlock(parsed.requestType),
  );

  // "Don't have a draft yet? Schedule a call" — sits right under the
  // draft field so it's visible in context, not buried in the footer.
  const scheduleBlock = scheduleCallBlock(parsed.requestType);
  if (scheduleBlock) blocks.push(scheduleBlock);

  blocks.push(
    deadlineBlock(parsed.deadline ?? null),
    liveDateBlock(),
  );

  // Rush banner — fires when the prefilled deadline is already within
  // Pearl's 2-week turnaround. Re-renders dynamically when the user
  // changes the date pickers (see DEADLINE_ACTION_ID handler).
  const rushBlock = rushBannerBlock(parsed.deadline, null);
  if (rushBlock) blocks.push(rushBlock);

  blocks.push(
    approvalsBlock(),
    additionalDivisionsBlock(parsed.additionalDivisionsImpacted ?? null),
    requestingForBlock(),
  );

  // Don't offer a press release add-on if the request is already a press release.
  const filteredRecs = parsed.requestType === 'press_release'
    ? recommendations.filter((r) => !/press.release/i.test(r.name + ' ' + r.deliverable))
    : recommendations;
  const trimmedRecs = filteredRecs.slice(0, MAX_RECOMMENDATIONS);
  if (trimmedRecs.length > 0) {
    // Group reasonings — recommendations from the same rule share a
    // single explanation. We surface that ONCE as a context block,
    // then list the checkbox options without per-option duplication.
    const uniqueReasonings = Array.from(
      new Set(trimmedRecs.map((r) => r.reasoning).filter(Boolean)),
    );

    blocks.push(
      { type: 'divider' },
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: 'Do you also need any of these?',
          emoji: true,
        },
      },
    );

    if (uniqueReasonings.length > 0) {
      blocks.push({
        type: 'context',
        elements: uniqueReasonings.map((r) => ({
          type: 'mrkdwn',
          text: `_${r}_`,
        })),
      });
    }

    blocks.push(recommendationsBlock(trimmedRecs));
  }

  // Footer — calendar link for "if you're stuck, talk it through with
  // marketing first." Sits at the bottom so it's an off-ramp, not a
  // distraction during form fill. Only rendered if a calendar URL is
  // configured.
  const calendarUrl = process.env.MARKETING_LEAD_CALENDAR_URL;
  if (calendarUrl) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Need to talk this through with marketing first? <${calendarUrl}|Schedule 30 minutes>.`,
          },
        ],
      },
    );
  }

  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: 'New marketing request', emoji: true },
    submit: { type: 'plain_text', text: 'Submit', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks,
  };
}

// --- Block builders ---

function requestTypeBlock(initial: string | null | undefined): any {
  const matched = REQUEST_TYPE_OPTIONS.find((o) => o.value === initial);
  const block: any = {
    type: 'input',
    block_id: 'request_type',
    // dispatch_action so the email-policy banner can show/hide
    // when the user changes the selection.
    dispatch_action: true,
    label: { type: 'plain_text', text: 'Primary deliverable', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'Pick the main thing you need. If this is part of a bigger initiative — like an event — you can add the rest under "Anything else you need?" just below.',
      emoji: true,
    },
    element: {
      type: 'static_select',
      action_id: REQUEST_TYPE_ACTION_ID,
      options: REQUEST_TYPE_OPTIONS.map(({ value, label }) => ({
        value,
        text: { type: 'plain_text', text: label },
      })),
    },
  };
  if (matched) {
    block.element.initial_option = {
      value: matched.value,
      text: { type: 'plain_text', text: matched.label },
    };
  }
  return block;
}

// Additional deliverables reuse the SAME menu as the primary deliverable
// (minus "Other"), so the two lists can never drift apart.
const ADDITIONAL_DELIVERABLE_OPTIONS = REQUEST_TYPE_OPTIONS.filter(
  (o) => o.value !== 'other',
);

function additionalDeliverablesBlock(initial: string[] | null | undefined): any {
  const selected = (initial ?? [])
    .map((v) => ADDITIONAL_DELIVERABLE_OPTIONS.find((o) => o.value === v))
    .filter(Boolean) as { value: string; label: string }[];
  const element: any = {
    type: 'multi_static_select',
    action_id: 'value',
    placeholder: { type: 'plain_text', text: 'Select any additional deliverables' },
    options: ADDITIONAL_DELIVERABLE_OPTIONS.map(({ value, label }) => ({
      value,
      text: { type: 'plain_text', text: label },
    })),
  };
  if (selected.length > 0) {
    element.initial_options = selected.map(({ value, label }) => ({
      value,
      text: { type: 'plain_text', text: label },
    }));
  }
  return {
    type: 'input',
    block_id: 'additional_deliverables',
    optional: true,
    label: { type: 'plain_text', text: 'Anything else you need?', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'Add any other deliverables for the same initiative — each becomes its own tracked item, so you only fill this out once.',
      emoji: true,
    },
    element,
  };
}

function deliverableBlock(initial: string | null | undefined): any {
  return {
    type: 'input',
    block_id: 'deliverable',
    label: {
      type: 'plain_text',
      text: 'What do you need? (more context = better result)',
      emoji: true,
    },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

function audienceBlock(initial: string | null | undefined): any {
  return {
    type: 'input',
    block_id: 'audience',
    label: {
      type: 'plain_text',
      text: "Audience (who's this for?)",
      emoji: true,
    },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

function eventOrProjectBlock(initial: string | null | undefined): any {
  return {
    type: 'input',
    block_id: 'event_or_project',
    optional: true,
    label: {
      type: 'plain_text',
      text: 'Related event or project',
      emoji: true,
    },
    hint: {
      type: 'plain_text',
      text: 'If this is part of a bigger event, launch, or campaign, name it here. Leave blank if it stands on its own.',
      emoji: true,
    },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      placeholder: {
        type: 'plain_text',
        text: 'e.g. NAR Houston, Pearl Pro launch',
      },
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

export const DEADLINE_ACTION_ID = 'sage_v2_deadline_change';
export const LIVE_DATE_ACTION_ID = 'sage_v2_live_date_change';

function deadlineBlock(initial: string | null | undefined): any {
  const block: any = {
    type: 'input',
    block_id: 'deadline',
    dispatch_action: true,
    label: {
      type: 'plain_text',
      text: 'Deadline (when you need it in hand)',
      emoji: true,
    },
    element: {
      type: 'datepicker',
      action_id: DEADLINE_ACTION_ID,
    },
  };
  if (initial && /^\d{4}-\d{2}-\d{2}$/.test(initial)) {
    block.element.initial_date = initial;
  }
  return block;
}

function liveDateBlock(): any {
  return {
    type: 'input',
    block_id: 'live_date',
    dispatch_action: true,
    label: {
      type: 'plain_text',
      text: 'Go live or event date (when it goes to your audience)',
      emoji: true,
    },
    element: {
      type: 'datepicker',
      action_id: LIVE_DATE_ACTION_ID,
    },
  };
}

function approvalsBlock(): any {
  return {
    type: 'input',
    block_id: 'approvals',
    label: {
      type: 'plain_text',
      text: 'Approvers (anyone whose sign-off is needed)',
      emoji: true,
    },
    element: {
      type: 'multi_users_select',
      action_id: 'value',
    },
  };
}

const NONE_OPTION_VALUE = '__NONE__';

function additionalDivisionsBlock(initial: Division[] | null): any {
  const optionsWithNone = [
    {
      value: NONE_OPTION_VALUE,
      text: { type: 'plain_text', text: 'None — just my division' },
    },
    ...DIVISION_OPTIONS.map(({ value, label }) => ({
      value,
      text: { type: 'plain_text', text: label },
    })),
  ];

  const block: any = {
    type: 'input',
    block_id: 'additional_divisions',
    label: {
      type: 'plain_text',
      text: "Other divisions impacted (or 'None')",
      emoji: true,
    },
    element: {
      type: 'multi_static_select',
      action_id: 'value',
      options: optionsWithNone,
    },
  };
  if (initial && initial.length > 0) {
    block.element.initial_options = initial.map((d) => {
      const match = DIVISION_OPTIONS.find((o) => o.value === d)!;
      return { value: match.value, text: { type: 'plain_text', text: match.label } };
    });
  }
  return block;
}

function requestingForBlock(): any {
  return {
    type: 'input',
    block_id: 'requesting_for',
    optional: true,
    label: {
      type: 'plain_text',
      text: 'Requesting on behalf of (only if filing for someone else)',
      emoji: true,
    },
    element: {
      type: 'users_select',
      action_id: 'value',
    },
  };
}

/**
 * Returns the "draft / source material" input. Required when the
 * selected request type has a policy (email, deck, copy types) — Pearl
 * can't start work on those without the draft. Optional for types
 * marketing produces from scratch (graphic, event, research, etc.).
 *
 * Hint text adapts per type so the requester knows exactly what to
 * paste.
 */
export const SCHEDULE_CALL_BLOCK_ID = 'schedule_call_under_draft';

/**
 * Returns the "Don't have a draft yet? Schedule a call" context block
 * that sits right under the draft field. Only shown when the request
 * type has a policy AND the calendar URL is configured.
 */
export function scheduleCallBlock(
  requestType: string | null | undefined,
): any | null {
  const policyApplies = requestType ? requestType in REQUEST_TYPE_POLICIES : false;
  if (!policyApplies) return null;

  const calendarUrl = process.env.MARKETING_LEAD_CALENDAR_URL;
  if (!calendarUrl) return null;

  return {
    type: 'context',
    block_id: SCHEDULE_CALL_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text: `Don't have a draft yet? <${calendarUrl}|Schedule 30 minutes to talk it through with marketing>.`,
      },
    ],
  };
}

export function draftBlock(requestType: string | null | undefined): any {
  const policyApplies = requestType ? requestType in REQUEST_TYPE_POLICIES : false;

  let hint: string;
  switch (requestType) {
    case 'email':
      hint = 'What do you have that can help marketing get started? Paste a link to your draft email — Google Doc, Word, or even rough notes work.';
      break;
    case 'presentation':
      hint = 'What do you have that can help marketing get started? Paste a link to your draft deck — audience and key message should already be decided.';
      break;
    case 'webinar':
      hint = 'What do you have that can help marketing get started? Paste a link to your agenda, talking points, or any doc with audience, goal, and key info.';
      break;
    case 'press_release':
    case 'blog':
    case 'landing_page':
    case 'social_media':
    case 'document':
    case 'ebook':
      hint = 'What do you have that can help marketing get started? Paste a link to your talking points, outline, or any relevant doc — even rough notes help.';
      break;
    default:
      hint = 'Optional — paste a link to any source material, brand examples, or relevant context that can help marketing understand what you need.';
  }

  const label = policyApplies
    ? 'Links to draft or source material (required)'
    : 'Links to draft or source material';

  return {
    type: 'input',
    block_id: 'draft_source',
    optional: !policyApplies,
    label: {
      type: 'plain_text',
      text: label,
      emoji: true,
    },
    hint: { type: 'plain_text', text: hint },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: true,
    },
  };
}

function recommendationsBlock(recs: Recommendation[]): any {
  return {
    type: 'input',
    block_id: 'recommendations',
    optional: true,
    label: { type: 'plain_text', text: 'Add-ons', emoji: true },
    element: {
      type: 'checkboxes',
      action_id: 'value',
      options: recs.map((rec) => ({
        // value stays as the slug for downstream tracking; user-visible
        // text is the human-readable deliverable description.
        value: rec.name,
        text: { type: 'plain_text', text: truncateForCheckbox(rec.deliverable) },
      })),
    },
  };
}

/**
 * Slack checkbox option text has a 75-char limit. Truncate cleanly,
 * adding an ellipsis if we cut.
 */
function truncateForCheckbox(text: string): string {
  if (text.length <= 75) return text;
  return text.slice(0, 72).trimEnd() + '…';
}
