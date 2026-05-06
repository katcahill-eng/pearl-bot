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
export const EMAIL_POLICY_BLOCK_ID = 'email_policy_banner';

/**
 * Returns the email-policy heads-up block when the selected request
 * type is "email" AND the channel's division isn't Corporate. Used
 * both at modal-open time and on dynamic re-render when the user
 * changes the Request Type select.
 */
export function emailPolicyBlock(
  requestType: string | null,
  channelId: string,
): any | null {
  if (requestType !== 'email') return null;
  const division = divisionForChannel(channelId);
  if (division === 'Corporate') return null;

  return {
    type: 'context',
    block_id: EMAIL_POLICY_BLOCK_ID,
    elements: [
      {
        type: 'mrkdwn',
        text:
          ":warning: *Heads up on emails:* marketing reviews emails for brand alignment but doesn't draft division-voice copy — your division owns its voice and audience. " +
          'You draft, we review. (Corporate-voice emails are the exception.) ' +
          "Marketing can still help on infrastructure (HubSpot setup, distribution lists, templates).",
      },
    ],
  };
}

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'webinar', label: 'Webinar' },
  { value: 'email', label: 'Email / campaign' },
  { value: 'graphic', label: 'Graphic / visual asset' },
  { value: 'blog', label: 'Blog post' },
  { value: 'presentation', label: 'Presentation / deck' },
  { value: 'press_release', label: 'Press release' },
  { value: 'event', label: 'Event / conference support' },
  { value: 'product_launch', label: 'Product launch' },
  { value: 'landing_page', label: 'Landing page / website' },
  { value: 'social_media', label: 'Social media' },
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

/**
 * Build a Slack view payload for the request modal, pre-filled from the
 * parser output and optionally augmented with director-brain
 * recommendations.
 */
export function buildRequestModal(
  parsed: ParsedRequest & { additionalDivisionsImpacted?: Division[] | null; deadline?: string | null },
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
    deliverableBlock(parsed.deliverable),
    audienceBlock(parsed.audience),
    eventOrProjectBlock(parsed.eventOrProject),
    deadlineBlock(parsed.deadline ?? null),
    liveDateBlock(),
    approvalsBlock(),
    additionalDivisionsBlock(parsed.additionalDivisionsImpacted ?? null),
    requestingForBlock(),
  );

  const trimmedRecs = recommendations.slice(0, MAX_RECOMMENDATIONS);
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
          text: 'Sage also flagged these — check any that apply',
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
    label: { type: 'plain_text', text: 'Request Type', emoji: true },
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

function deliverableBlock(initial: string | null | undefined): any {
  return {
    type: 'input',
    block_id: 'deliverable',
    label: { type: 'plain_text', text: 'What do you need?', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'A sentence or two about the ask. The more context, the better the result.',
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
    label: { type: 'plain_text', text: 'Audience', emoji: true },
    hint: {
      type: 'plain_text',
      text: "Who's this for? E.g. real estate agents, homeowners, BD partners.",
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
    label: { type: 'plain_text', text: 'Event or project', emoji: true },
    hint: {
      type: 'plain_text',
      text: "Tied to a specific event, conference, or product launch? Type 'N/A' if standalone.",
    },
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

function deadlineBlock(initial: string | null | undefined): any {
  const block: any = {
    type: 'input',
    block_id: 'deadline',
    label: { type: 'plain_text', text: 'Deadline', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'When do you need this in hand? Marketing typically needs ~2 weeks (1 week to draft + 1 week to review).',
    },
    element: {
      type: 'datepicker',
      action_id: 'value',
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
    label: { type: 'plain_text', text: 'Live or event date', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'When does this go out to your audience? Send date, webinar date, launch date. If same as the deadline, pick the same date.',
    },
    element: {
      type: 'datepicker',
      action_id: 'value',
    },
  };
}

function approvalsBlock(): any {
  return {
    type: 'input',
    block_id: 'approvals',
    label: { type: 'plain_text', text: 'Approvers', emoji: true },
    hint: {
      type: 'plain_text',
      text: "Anyone whose sign-off is needed before this goes out. They'll get an Approve button in your thread.",
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
      text: 'Other divisions impacted',
      emoji: true,
    },
    hint: {
      type: 'plain_text',
      text: "If this affects another Pearl division beyond yours. Pick 'None' if it doesn't.",
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
    label: { type: 'plain_text', text: 'Requesting on behalf of', emoji: true },
    hint: {
      type: 'plain_text',
      text: 'If someone else is the one who actually needs the work.',
    },
    element: {
      type: 'users_select',
      action_id: 'value',
    },
  };
}

function recommendationsBlock(recs: Recommendation[]): any {
  return {
    type: 'input',
    block_id: 'recommendations',
    optional: true,
    label: { type: 'plain_text', text: 'Add-ons', emoji: true },
    hint: {
      type: 'plain_text',
      text: "Each one I'll track as a linked sub-item so the team can pick them up alongside the main ask.",
    },
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
