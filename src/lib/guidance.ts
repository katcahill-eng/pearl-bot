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
