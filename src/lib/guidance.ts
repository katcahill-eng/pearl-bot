import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import type { CollectedData } from './conversation';

const client = new Anthropic();

const KNOWLEDGE_BASE = fs.readFileSync(
  path.join(__dirname, 'knowledge-base.md'),
  'utf-8',
);

/**
 * Generate contextual guidance when a user says "I don't know" for a field.
 * Uses templates for bounded fields, Claude for open-ended ones.
 */
export async function generateFieldGuidance(
  field: string,
  collectedData: Partial<CollectedData>,
): Promise<string> {
  switch (field) {
    case 'requester_department':
      return generateDepartmentGuidance();
    case 'target':
      return generateTargetGuidance(collectedData);
    case 'due_date':
      return generateDueDateGuidance(collectedData);
    default:
      return generateClaudeGuidance(field, collectedData);
  }
}

function generateDepartmentGuidance(): string {
  return (
    "No worries! Here are the departments that typically request marketing support:\n\n" +
    "• *CX* — Customer Experience\n" +
    "• *Corporate* — Corporate team\n" +
    "• *BD* — Business Development\n" +
    "• *Product* — Product team\n" +
    "• *P2* — Pearl Partner Program\n" +
    "• *Other* — Anything else\n\n" +
    "Which one are you part of?"
  );
}

function generateTargetGuidance(collectedData: Partial<CollectedData>): string {
  const context = (collectedData.context_background ?? '').toLowerCase();

  if (context.includes('conference') || context.includes('trade show') || context.includes('expo')) {
    return (
      "For conference-related requests, the audience is usually one of these:\n\n" +
      "• *Conference attendees* — people at the event\n" +
      "• *Real estate agents* — if it's an industry conference\n" +
      "• *Contractors / HVAC professionals* — if it's a trade show\n" +
      "• *Partners* — existing Pearl partners attending\n\n" +
      "Also — we have a *digital booth pilot* with 4 iPads that can be pre-loaded with demos or content. Something to consider!\n\n" +
      "Who are you trying to reach at the event?"
    );
  }

  return (
    "Here are some common audiences for Pearl marketing:\n\n" +
    "• *Homeowners* — current or prospective\n" +
    "• *Real estate agents* — individual agents or brokerages\n" +
    "• *Contractors / HVAC professionals*\n" +
    "• *Partners* — existing Pearl partners\n" +
    "• *Internal team* — Pearl employees\n\n" +
    "Who is this for?"
  );
}

function generateDueDateGuidance(collectedData: Partial<CollectedData>): string {
  const context = (collectedData.context_background ?? '').toLowerCase();
  const deliverables = (collectedData.deliverables ?? []).join(' ').toLowerCase();

  if (context.includes('conference') || context.includes('trade show') || context.includes('expo')) {
    return (
      "For conferences, we typically work backwards from the event date. " +
      "Do you know when the conference is? " +
      "I can help figure out when materials need to be ready."
    );
  }

  if (context.includes('webinar')) {
    return (
      "For webinars, we usually need the content ready 1-2 weeks before the session " +
      "to allow time for the registration page and promo. " +
      "When are you planning to hold the webinar?"
    );
  }

  if (context.includes('dinner') || context.includes('insider')) {
    return (
      "For dinners, we work backwards from the event date for invitations and branding. " +
      "When is the dinner? I'll help plan the timeline."
    );
  }

  const quickAssets = ['email', 'social', 'graphic', 'one-pager', 'flyer', 'banner', 'headshot', 'photo'];
  const isQuickAsset = quickAssets.some((a) => deliverables.includes(a) || context.includes(a));

  if (isQuickAsset) {
    return (
      "For single assets like this, we typically need 1-2 weeks. " +
      "Do you have a specific date in mind, or is there an event or launch driving the timeline?"
    );
  }

  return (
    "Here's a rough guide:\n" +
    "• *Quick assets* (email, social post, graphic) — 1-2 weeks\n" +
    "• *Full campaigns* (multi-channel, event support) — 4-6 weeks\n\n" +
    "Do you have a specific deadline, or is there an event or launch driving the timeline?"
  );
}

async function generateClaudeGuidance(
  field: string,
  collectedData: Partial<CollectedData>,
): Promise<string> {
  const collected = Object.entries(collectedData)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('\n');

  const fieldDescriptions: Record<string, string> = {
    deliverables: 'what deliverables/assets the marketing team should create',
    desired_outcomes: 'what the requester hopes to achieve with this request',
    context_background: 'the context and background for why this request exists',
  };

  const fieldDesc = fieldDescriptions[field] ?? field;

  const systemPrompt = `You are MarcomsBot, a friendly Slack intake assistant for Pearl's marketing team.
The user was asked about ${fieldDesc} and said they don't know.

Using the knowledge base and what's already been collected, give a brief, helpful suggestion to guide them.
Be conversational and warm — this is Slack, not a form.
End with a question they can answer.
Keep it to 2-4 sentences max.

KNOWLEDGE BASE:
${KNOWLEDGE_BASE}`;

  const userPrompt = `Already collected:\n${collected || 'Nothing yet'}\n\nThe user said "I don't know" when asked about: ${field}. Help them.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return text.trim();
  } catch (err) {
    console.error('[guidance] Claude guidance generation failed:', err);
    // Fallback for each field
    if (field === 'context_background') {
      return "No worries! Are you working on an event, launching something, supporting a campaign, or something else entirely?";
    }
    if (field === 'desired_outcomes') {
      return "That's okay! What would success look like for this project? For example, more sign-ups, better awareness, leads from an event?";
    }
    if (field === 'deliverables') {
      return "No problem! What kind of thing are you picturing — an email, social posts, a one-pager, a slide deck, or something else?";
    }
    return "No worries — you can say *skip* to move on, *discuss* to flag it for a conversation with marketing, or give your best guess and the team will refine it.";
  }
}

// --- Type Probes: Critical probing questions per request type ---

export interface TypeProbe {
  fieldKey: string;       // snake_case key for storing the answer
  question: string;       // conversational question text (Slack mrkdwn)
  keywords: RegExp;       // regex to check if Claude already asked about this topic
  priority: number;       // lower = asked earlier
}

export const TYPE_PROBES: Record<string, TypeProbe[]> = {
  conference: [
    {
      fieldKey: 'conference_presenting',
      question: 'Are we presenting at the conference or on a panel? If so, do you need help with presentation materials?',
      keywords: /present|panel|speak|keynote|talk|podium/i,
      priority: 1,
    },
    {
      fieldKey: 'conference_private_event',
      question: 'Are you planning to host a private event (like an executive dinner or reception) alongside the conference?',
      keywords: /private\s*event|dinner|hospitality|reception|side\s*event/i,
      priority: 2,
    },
    {
      fieldKey: 'conference_sponsorship',
      question: 'Do you need help evaluating or determining the right sponsorship level? Some tiers include specific deliverables we can help fulfill.',
      keywords: /sponsor/i,
      priority: 3,
    },
    {
      fieldKey: 'conference_booth',
      question: 'Will you have a booth? If so, do you need collateral, signage, or printed materials?\n\n_Note: Printed materials and production costs are charged back to your department._',
      keywords: /booth|collateral|signage|exhibit/i,
      priority: 4,
    },
    {
      fieldKey: 'conference_digital_booth',
      question: 'Would you be interested in our digital conference booth pilot? We have 4 iPads that can be pre-programmed with collateral, demo lap accounts, and video walkthroughs — they\'re portable and work great for meetings, dinners, or hallway conversations at the event.',
      keywords: /digital\s*booth|ipad|pilot|demo\s*lap/i,
      priority: 5,
    },
    {
      fieldKey: 'conference_promo_campaigns',
      question: 'Do you need pre-conference or post-conference promotional campaigns? We can help with emails, social media, or digital ads to drive booth traffic or follow up with leads.',
      keywords: /pre.?conference|post.?conference|promot|campaign|follow.?up\s*(email|campaign)/i,
      priority: 6,
    },
  ],
  webinar: [
    {
      fieldKey: 'webinar_hosting',
      question: 'Is Pearl hosting this webinar or are we a guest on someone else\'s?',
      keywords: /host|guest|our\s*webinar|someone\s*else/i,
      priority: 1,
    },
    {
      fieldKey: 'webinar_promotion',
      question: 'Do you need promotional support — like emails, social media posts, or digital ads — to drive registrations?',
      keywords: /promot|registr|sign.?up|drive.*(attend|registr)|ads?\b/i,
      priority: 2,
    },
    {
      fieldKey: 'webinar_format',
      question: 'What type of webinar are you thinking?\n\n• *Live* — real-time via Zoom, great for Q&A\n• *Pre-recorded* — polished and edited, automated playback via GoTo\n• *Evergreen* — record a live session, then run it on-demand as an automated encore\n\nYou can also start live and convert to evergreen later — not sure which fits? We can help you decide.',
      keywords: /format|live|pre.?record|evergreen|zoom|goto/i,
      priority: 3,
    },
    {
      fieldKey: 'webinar_follow_up',
      question: 'Do you need post-webinar follow-up emails to attendees and no-shows?',
      keywords: /follow.?up|post.?webinar|no.?show|attendee/i,
      priority: 4,
    },
  ],
  insider_dinner: [
    {
      fieldKey: 'dinner_theme',
      question: 'Is there a theme or specific topic for this dinner? This helps us shape the branding and any presentation materials.',
      keywords: /theme|topic|agenda|subject/i,
      priority: 1,
    },
    {
      fieldKey: 'dinner_guest_count',
      question: 'How many guests are expected? This helps us plan the right amount of printed materials and branding.',
      keywords: /guest|attendee|invit|capacity|headcount|how\s*many/i,
      priority: 2,
    },
    {
      fieldKey: 'dinner_follow_up',
      question: 'Do you need post-event follow-up emails to attendees?',
      keywords: /follow.?up|post.?event|post.?dinner/i,
      priority: 3,
    },
  ],
  email: [
    {
      fieldKey: 'email_type',
      question: 'What type of email is this?\n\n• *Promotional* — driving action (sign-ups, registrations)\n• *Newsletter* — regular update or digest\n• *Event invite* — webinar, dinner, conference\n• *Follow-up* — post-event or nurture sequence',
      keywords: /type\s*of\s*email|promotional|newsletter|invite|sequence|nurture/i,
      priority: 1,
    },
    {
      fieldKey: 'email_sequence',
      question: 'Is this a one-time send or part of a sequence? If it\'s a sequence, how many emails are you envisioning?',
      keywords: /one.?time|sequence|series|drip|how\s*many\s*email/i,
      priority: 2,
    },
  ],
  graphic_design: [
    {
      fieldKey: 'design_usage',
      question: 'Where will this be used — digital, print, social media, or a presentation? This helps us get the dimensions right.',
      keywords: /where.*used|digital|print|dimension|size|format|resolution/i,
      priority: 1,
    },
    {
      fieldKey: 'design_existing_content',
      question: 'Do you have existing content or copy for this, or do you need that written too?',
      keywords: /existing\s*content|copy|draft|text|written/i,
      priority: 2,
    },
  ],
};

/**
 * Get all critical probing questions for the given request types.
 * Sorted by priority within each type, with types in the order provided.
 */
export function getProbesForTypes(requestTypes: string[]): TypeProbe[] {
  const probes: TypeProbe[] = [];
  const seenFieldKeys = new Set<string>();

  for (const type of requestTypes) {
    const typeProbes = TYPE_PROBES[type];
    if (!typeProbes) continue;
    for (const probe of typeProbes) {
      if (!seenFieldKeys.has(probe.fieldKey)) {
        seenFieldKeys.add(probe.fieldKey);
        probes.push(probe);
      }
    }
  }

  return probes.sort((a, b) => a.priority - b.priority);
}

/**
 * Build a knowledge block describing the critical probing topics for each type.
 * Injected into the generateFollowUpQuestions prompt so Claude naturally covers these.
 */
export function buildProbeKnowledgeBlock(requestTypes: string[]): string {
  const blocks: string[] = [];

  const typeLabels: Record<string, string> = {
    conference: 'Conference',
    webinar: 'Webinar',
    insider_dinner: 'Insider Dinner',
    email: 'Email',
    graphic_design: 'Graphic Design',
  };

  for (const type of requestTypes) {
    const probes = TYPE_PROBES[type];
    if (!probes || probes.length === 0) continue;

    const label = typeLabels[type] ?? type;
    const items = probes.map((p) =>
      `  - ${p.question.split('\n')[0]}`
    ).join('\n');
    blocks.push(`For ${label} requests, a good marketing consultant would proactively ask about:\n${items}`);
  }

  return blocks.length > 0
    ? `\nPROACTIVE CONSULTANT GUIDANCE:\n${blocks.join('\n\n')}\n\nTry to naturally incorporate these topics into your follow-up questions. You don't need to ask them word-for-word — rephrase them conversationally and combine related ones where it makes sense.\n`
    : '';
}

/**
 * Generate a context-aware list of available deliverables/services based on the request context.
 * Shown when users ask "What are my options?" during the deliverables step.
 */
export function generateDeliverablesOptions(collectedData: Partial<CollectedData>): string {
  const context = (collectedData.context_background ?? '').toLowerCase();
  const sections: string[] = [];

  const hasWebinar = /webinar|web\s*session|online\s*presentation/.test(context);
  const hasConference = /conference|trade\s*show|expo|exhibition/.test(context);
  const hasDinner = /dinner|insider/.test(context);
  const hasEmail = /email\s*campaign|email\s*sequence|newsletter/.test(context);

  if (hasWebinar) {
    sections.push(
      '*Webinar support:*\n' +
      '• Presentation slide deck design\n' +
      '• Webinar registration page setup\n' +
      '• Social media promotion (before, during, and after)\n' +
      '• Email promotion (before, during, and after) — _copy only; CX handles HubSpot build_\n' +
      '• Post-webinar follow-up email copy\n' +
      '• Ad creative for webinar promotion'
    );
  }

  if (hasConference) {
    sections.push(
      '*Conference support:*\n' +
      '• Presentation slide deck design\n' +
      '• Booth collateral & signage\n' +
      '• One-pagers, handouts, flyers\n' +
      '• Pre/post-conference email campaigns — _copy only; CX handles HubSpot_\n' +
      '• Social media promotion\n' +
      '• Digital booth pilot (4 iPads pre-loaded with demos/content — portable!)\n' +
      '• Printed materials — _note: print costs are charged back to your department_'
    );
  }

  if (hasDinner) {
    sections.push(
      '*Insider Dinner support:*\n' +
      '• Invitation design & copy\n' +
      '• Event branding & signage\n' +
      '• Presentation or slide deck\n' +
      '• Post-event follow-up email copy\n' +
      '• Social media coverage plan'
    );
  }

  if (hasEmail) {
    sections.push(
      '*Email support:*\n' +
      '• Email copywriting (promotional, newsletter, event invite, follow-up)\n' +
      '• Email template design\n' +
      '• Subject line & preview text\n' +
      '_Note: CX handles HubSpot builds, list segmentation, and sending._'
    );
  }

  // If no specific type detected, or as a catch-all, show general options
  if (sections.length === 0) {
    sections.push(
      '*Here\'s what marketing can help with:*\n\n' +
      '*Design & collateral:*\n' +
      '• One-pagers, flyers, banners, brochures\n' +
      '• Social media graphics\n' +
      '• Presentation slide decks\n' +
      '• Signage & event branding\n\n' +
      '*Email:*\n' +
      '• Email copywriting & template design\n' +
      '• Campaign sequences — _CX handles HubSpot build_\n\n' +
      '*Events:*\n' +
      '• Webinar support (slides, registration page, promo)\n' +
      '• Conference materials (booth, collateral, emails)\n' +
      '• Dinner invitations & branding\n\n' +
      '*Digital:*\n' +
      '• Ad creative (LinkedIn, Meta, Google)\n' +
      '• Landing page copy\n' +
      '• Social media posts'
    );
  }

  const intro = sections.length === 1 && !hasWebinar && !hasConference && !hasDinner && !hasEmail
    ? '' // General list already has its own intro
    : 'Here\'s what we can help with for your request:\n\n';

  return `${intro}${sections.join('\n\n')}\n\nJust tell me which ones you need! You can pick specific items, or say something like "the full package" if you want everything listed.`;
}
