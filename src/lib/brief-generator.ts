import Anthropic from '@anthropic-ai/sdk';
import type { CollectedData } from './conversation';
import type { RequestClassification } from './claude';

// --- Client ---

const client = new Anthropic();

// --- Templates ---

const MINI_BRIEF_SYSTEM_PROMPT = `You are a marketing brief writer for Pearl, a home performance company.
Generate a concise mini-brief in markdown format for a quick marketing request.

Use this exact structure:

# Quick Request Brief

| Field | Details |
|-------|---------|
| **Requester** | [requester name] |
| **Department** | [department] |
| **Date** | [today's date] |

## Target Audience
[Who this request is targeting]

## Context & Background
[Why this request exists — context and background from the requester]

## Desired Outcomes
[What the requester hopes to achieve]

## Deliverable
[Specific deliverable(s) needed]

## Due Date
[Due date]

## Approvals
[Any approval requirements — or "None specified"]

## Constraints
[Any constraints — or "None specified"]

## Supporting Links / References
[Any mentioned links, references, or materials — or "None provided"]

Rules:
- Keep it concise and actionable
- Write in a professional but clear tone
- Fill in narrative sections based on the collected data — don't just repeat the raw fields
- If a field has no data, write "Not specified" rather than leaving it blank
- Output ONLY the markdown brief, no preamble or explanation`;

const FULL_BRIEF_SYSTEM_PROMPT = `You are a marketing brief writer for Pearl, a home performance company.
Generate an Operational Brief in markdown format for a full marketing project.

Use this exact structure — the header table and sections A through L must all appear in order:

# OPERATIONAL BRIEF

| Field | Details |
|-------|---------|
| **Department** | Marketing |
| **Project** | [Project Name] |
| **From** | [requester name] |
| **Requesting Department** | [department] |
| **Date** | [today's date] |
| **Project #** | [project number if provided, otherwise "TBD"] |
| **Draft** | 1.0 |

## I. [Project Name]

## A. Background
[2-3 sentences of context from the requester's Context & Background field: why does this project exist? What business need or opportunity prompted it?]

## B. Project Overview
[1-2 paragraph overview of the project scope, what it involves, and how it fits into Pearl's broader goals]

## C. How it is Today
[Describe the current state — what exists now, what gap or problem this project addresses]

## D. Target Audience
[Who this project is targeting, based on the Target field]

## E. Objective
[Bullet list of specific, measurable objectives derived from the Desired Outcomes field]

## F. Success Criteria
[How we will know this project succeeded — specific measurable outcomes]

## G. Deliverables
[Numbered list of all deliverables with specifications where known]

## H. Activities / Phases

| Phase | Description | Target Date |
|-------|-------------|-------------|
| Brief submitted | Project kickoff | [today] |
| [Inferred phases based on deliverables and due date] | [description] | [dates] |
| Final delivery | All deliverables complete | [due date] |

## I. Risk Mitigation
[Identify 2-3 potential risks and how to mitigate them — e.g., timeline pressure, missing assets, stakeholder alignment]

## J. Timing
- **Due Date:** [due date]
- **Key Milestones:** [any specific dates or dependencies mentioned]

## K. Team / Reporting
- **Requester:** [requester name]
- **Department:** [department]
- **Marketing Lead:** TBD (assigned at triage)
- **Approvals Required:** [approvals or "None specified"]

## L. Constraints & Guidelines
[Any constraints specified by the requester. Also note: Pearl brand guidelines should be followed. Note any special requirements.]

## M. Supporting Links & References
[List of any links, references, or materials mentioned — or "None provided"]

Rules:
- Write narrative sections based on the collected data — add professional context and structure, don't just repeat raw fields
- Infer reasonable objectives, success criteria, and risk factors from the request context
- For Background and Project Overview, connect to Pearl's mission of making home performance matter where relevant
- For Activities/Phases, create reasonable milestones between now and the due date
- If a field has no data, write "Not specified" rather than leaving it blank
- Output ONLY the markdown brief, no preamble or explanation`;

// --- Public API ---

/**
 * Generate a marketing brief from collected intake data.
 * Returns a markdown string with either a mini-brief (quick) or full creative brief (full).
 */
export async function generateBrief(
  collectedData: CollectedData,
  classification: RequestClassification,
  requesterName?: string,
): Promise<string> {
  const today = new Date().toISOString().split('T')[0];
  const isQuick = classification === 'quick';

  const systemPrompt = isQuick
    ? MINI_BRIEF_SYSTEM_PROMPT
    : FULL_BRIEF_SYSTEM_PROMPT;

  const userPrompt = buildBriefPrompt(collectedData, requesterName ?? 'Unknown', today);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';

  return text.trim();
}

// --- Helpers ---

function buildBriefPrompt(
  data: CollectedData,
  requesterName: string,
  today: string,
): string {
  const lines: string[] = [
    `Today's date: ${today}`,
    `Requester: ${data.requester_name ?? requesterName}`,
    '',
    'Collected intake data:',
    `- Department: ${data.requester_department ?? 'Not specified'}`,
    `- Target audience: ${data.target ?? 'Not specified'}`,
    `- Context & background: ${data.context_background ?? 'Not specified'}`,
    `- Desired outcomes: ${data.desired_outcomes ?? 'Not specified'}`,
    `- Deliverables: ${data.deliverables.length > 0 ? data.deliverables.join(', ') : 'Not specified'}`,
    `- Due date: ${data.due_date ?? 'Not specified'}`,
  ];

  if (data.approvals) {
    lines.push(`- Approvals required: ${data.approvals}`);
  }
  if (data.constraints) {
    lines.push(`- Constraints: ${data.constraints}`);
  }
  if (data.supporting_links.length > 0) {
    lines.push(`- Supporting links: ${data.supporting_links.join(', ')}`);
  }

  lines.push('');
  lines.push('Generate the brief now.');

  return lines.join('\n');
}
