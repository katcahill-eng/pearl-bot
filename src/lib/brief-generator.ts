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
| **From** | [requester initials — derive from the requester name, e.g. "KC" for Kat Cahill, "JS" for Jane Smith] |
| **Date** | [today's date, formatted as Month DD, YYYY — e.g. "February 20, 2026"] |
| **Project #** | [project number if provided, otherwise "TBD"] |
| **Draft** | 1.0 |

## I. [Project Name]

## A. Background
*How did we get here in a nutshell?*
[2-3 sentences of context from the requester's Context & Background field: why does this project exist? What business need or opportunity prompted it?]

## B. Project Overview
*Briefly describe the purpose of the exercise. Specifically address: who the instigator is, their need and motivation for this project, and what you want done succinctly.*
[1-2 paragraph overview of the project scope, what it involves, who the target audience is, and how it fits into Pearl's broader goals]

## C. How it is Today
*Define the situation as it is today — specifically, the problem you are trying to solve.*
[Describe the current state — what exists now, what gap or problem this project addresses]

## D. Objective
*What do you need to accomplish with this project?*
[Bullet list of specific, measurable objectives derived from the Desired Outcomes field. Include who the target audience is and what we want them to do.]

## E. Success Criteria
*How will you know if you accomplished it?*
[How we will know this project succeeded — specific measurable outcomes]

## F. Deliverables
*List the specific deliverables you are expecting as a result of this project.*
[Numbered list of all deliverables with specifications where known]

## G. Activities / Phases
*List the activities required to arrive at each of the deliverables.*

| Phase | Description | Target Date |
|-------|-------------|-------------|
| Brief submitted | Project kickoff | [today] |
| [Inferred phases based on deliverables and due date] | [description] | [dates] |
| Final delivery | All deliverables complete | [due date] |

## H. Risk Mitigation
*What factors pose the greatest risk of failure for this project?*
[Identify 2-3 potential risks and how to mitigate them — e.g., timeline pressure, missing assets, stakeholder alignment]

## I. Timing
*Summarize key milestones and the overall timeline.*
- **Due Date:** [due date]
- **Key Milestones:** [any specific dates or dependencies mentioned]

## J. Team / Reporting
*Now that we know what needs to be done, who does what?*
- **Requester:** [requester name]
- **Department:** [department]
- **Marketing Lead:** TBD (assigned at triage)
- **Approvals Required:** [approvals or "None specified"]

## K. Guidelines or Suggestions
*Any mandatories, tips, or requests?*
[Any constraints specified by the requester. Also note: Pearl brand guidelines should be followed. Note any special requirements.]

## L. Attachments
*Any documents attached related to this assignment?*
[List of any links, references, or materials mentioned — or "None provided"]

Rules:
- Write narrative sections based on the collected data — add professional context and structure, don't just repeat raw fields
- Infer reasonable objectives, success criteria, and risk factors from the request context
- For Background and Project Overview, connect to Pearl's mission of making home performance matter where relevant
- For Activities/Phases, create reasonable milestones between now and the due date
- Weave target audience information naturally into sections B (Project Overview) and D (Objective) — there is no standalone Target Audience section
- For the "From" field, derive initials from the requester name (e.g., "Jane Smith" becomes "JS", "Kat Cahill" becomes "KC")
- Format the date in the header as "Month DD, YYYY" (e.g., "January 15, 2026")
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
  projectNumber?: string,
): Promise<string> {
  const today = new Date().toISOString().split('T')[0];
  const isQuick = classification === 'quick';

  const systemPrompt = isQuick
    ? MINI_BRIEF_SYSTEM_PROMPT
    : FULL_BRIEF_SYSTEM_PROMPT;

  const userPrompt = buildBriefPrompt(collectedData, requesterName ?? 'Unknown', today, projectNumber);

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
  projectNumber?: string,
): string {
  const lines: string[] = [
    `Today's date: ${today}`,
    `Requester: ${data.requester_name ?? requesterName}`,
    `Project number: ${projectNumber ?? 'TBD'}`,
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
