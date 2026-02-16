import {
  getConversation,
  upsertConversation,
  type Conversation,
} from './db';

// --- Types ---

export interface CollectedData {
  requester_name: string | null;
  requester_department: string | null;
  target: string | null;
  context_background: string | null;
  desired_outcomes: string | null;
  deliverables: string[];
  due_date: string | null;
  due_date_parsed: string | null;
  approvals: string | null;
  constraints: string | null;
  supporting_links: string[];
  request_type: string | null;
  additional_details: Record<string, string>;
  conference_start_date: string | null;
  conference_end_date: string | null;
  presenter_names: string | null;
  outside_presenters: string | null;
}

export type ConversationStatus = Conversation['status']; // includes 'withdrawn'
export type Classification = Conversation['classification'];

/** Fields in the order they should be asked. */
const REQUIRED_FIELDS: (keyof CollectedData)[] = [
  'requester_name',
  'requester_department',
  'target',
  'context_background',
  'desired_outcomes',
  'deliverables',
  'due_date',
];

/** Prompts and examples for each intake field. */
const FIELD_PROMPTS: Record<string, { question: string; example: string }> = {
  requester_name: {
    question: "What's your name?",
    example: 'e.g., "Jane Smith", "Alex from BD"',
  },
  requester_department: {
    question: 'Which department is requesting marketing support?',
    example: 'e.g., CX, Corporate, BD, Product, P2, or Other',
  },
  target: {
    question: 'Who is the target audience for this request?',
    example: 'e.g., "Homeowners in the Southeast", "Real estate agents", "Internal team", "Conference attendees at AHR Expo"',
  },
  context_background: {
    question: 'Can you share some context and background on this request?',
    example: 'e.g., "We\'re launching a new certification tier in Q2 and need marketing support to drive awareness among existing partners"',
  },
  desired_outcomes: {
    question: 'What are the desired outcomes?',
    example: 'e.g., "Increase partner sign-ups by 20%", "Generate 50 qualified leads from the conference", "Drive awareness of the new program"',
  },
  deliverables: {
    question: 'What deliverable(s) do you need?',
    example: 'e.g., "1 one-pager (PDF), 3 social posts, 1 email template" — list as many as you need',
  },
  // due_date is handled dynamically by getDueDatePrompt() — this is a fallback
  due_date: {
    question: 'When do you need this by?',
    example: 'e.g., "next Friday", "February 15", "end of month", "ASAP"',
  },
  approvals: {
    question: 'Are there any specific approvals needed? (optional — you can say "skip")',
    example: 'e.g., "VP of Sales needs to sign off", "Legal review required", or "None"',
  },
  constraints: {
    question: 'Any constraints we should know about? (optional — you can say "skip")',
    example: 'e.g., "Must follow new brand guidelines", "Budget cap of $5K", "Cannot use competitor comparisons"',
  },
  supporting_links: {
    question: 'Any supporting links or references? (optional — you can say "skip")',
    example: 'e.g., "https://docs.google.com/...", "See competitor example at acme.com/page"',
  },
};

// --- ConversationManager ---

export class ConversationManager {
  private id: number | undefined;
  private userId: string;
  private userName: string;
  private channelId: string;
  private threadTs: string;
  private status: ConversationStatus;
  private currentStep: string | null;
  private collectedData: CollectedData;
  private classification: Classification;
  private mondayItemId: string | null;
  private triageMessageTs: string | null;
  private triageChannelId: string | null;

  constructor(opts: {
    id?: number;
    userId: string;
    userName: string;
    channelId: string;
    threadTs: string;
    status?: ConversationStatus;
    currentStep?: string | null;
    collectedData?: CollectedData;
    classification?: Classification;
    mondayItemId?: string | null;
    triageMessageTs?: string | null;
    triageChannelId?: string | null;
  }) {
    this.id = opts.id;
    this.userId = opts.userId;
    this.userName = opts.userName;
    this.channelId = opts.channelId;
    this.threadTs = opts.threadTs;
    this.status = opts.status ?? 'gathering';
    this.currentStep = opts.currentStep ?? null;
    this.collectedData = opts.collectedData ?? emptyCollectedData();
    this.classification = opts.classification ?? 'undetermined';
    this.mondayItemId = opts.mondayItemId ?? null;
    this.triageMessageTs = opts.triageMessageTs ?? null;
    this.triageChannelId = opts.triageChannelId ?? null;
  }

  /** Load an existing conversation from the DB, or return undefined. */
  static async load(userId: string, threadTs: string): Promise<ConversationManager | undefined> {
    const row = await getConversation(userId, threadTs);
    if (!row) return undefined;

    return new ConversationManager({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      status: row.status,
      currentStep: row.current_step,
      collectedData: parseCollectedData(row.collected_data),
      classification: row.classification,
      mondayItemId: row.monday_item_id ?? null,
      triageMessageTs: row.triage_message_ts ?? null,
      triageChannelId: row.triage_channel_id ?? null,
    });
  }

  // --- Getters ---

  getId(): number | undefined {
    return this.id;
  }

  getStatus(): ConversationStatus {
    return this.status;
  }

  getClassification(): Classification {
    return this.classification;
  }

  getCollectedData(): CollectedData {
    return JSON.parse(JSON.stringify(this.collectedData));
  }

  getCurrentStep(): string | null {
    return this.currentStep;
  }

  getUserId(): string {
    return this.userId;
  }

  getUserName(): string {
    return this.userName;
  }

  getThreadTs(): string {
    return this.threadTs;
  }

  getChannelId(): string {
    return this.channelId;
  }

  getMondayItemId(): string | null {
    return this.mondayItemId;
  }

  getTriageMessageTs(): string | null {
    return this.triageMessageTs;
  }

  getTriageChannelId(): string | null {
    return this.triageChannelId;
  }

  // --- Follow-up helpers ---

  isInFollowUp(): boolean {
    return this.currentStep?.startsWith('follow_up:') ?? false;
  }

  getFollowUpIndex(): number {
    if (!this.currentStep?.startsWith('follow_up:')) return 0;
    return parseInt(this.currentStep.split(':')[1], 10) || 0;
  }

  setFollowUpIndex(n: number): void {
    this.currentStep = `follow_up:${n}`;
  }

  setRequestType(type: string): void {
    this.collectedData.request_type = type;
  }

  setCurrentStep(step: string | null): void {
    this.currentStep = step;
  }

  // --- State transitions ---

  setStatus(status: ConversationStatus): void {
    this.status = status;
  }

  setClassification(classification: Classification): void {
    this.classification = classification;
  }

  setMondayItemId(itemId: string): void {
    this.mondayItemId = itemId;
  }

  /** Mark a single field as collected. */
  markFieldCollected(field: keyof CollectedData, value: string | string[] | Record<string, string>): void {
    if (field === 'additional_details') {
      this.collectedData.additional_details = value as Record<string, string>;
    } else if (field === 'deliverables' || field === 'supporting_links') {
      const arr = Array.isArray(value) ? value : [value as string];
      (this.collectedData[field] as string[]) = arr;
    } else {
      (this.collectedData[field] as string | null) = Array.isArray(value)
        ? value.join(', ')
        : value as string;
    }
  }

  /** Return the next required field that hasn't been answered yet. */
  getNextQuestion(): { field: keyof CollectedData; question: string; example: string } | null {
    for (const field of REQUIRED_FIELDS) {
      if (!isFieldPopulated(this.collectedData, field)) {
        this.currentStep = field;

        // Use context-aware prompts for certain fields
        if (field === 'deliverables') {
          const deliverablesPrompt = this.getDeliverablesPrompt();
          return { field, question: deliverablesPrompt.question, example: deliverablesPrompt.example };
        }
        if (field === 'due_date') {
          const dueDatePrompt = this.getDueDatePrompt();
          return { field, question: dueDatePrompt.question, example: dueDatePrompt.example };
        }

        const prompt = FIELD_PROMPTS[field];
        return { field, question: prompt.question, example: prompt.example };
      }
    }
    return null;
  }

  /** Generate a context-aware deliverables prompt based on collected data. */
  private getDeliverablesPrompt(): { question: string; example: string } {
    const context = (this.collectedData.context_background ?? '').toLowerCase();
    const target = (this.collectedData.target ?? '').toLowerCase();
    const outcomes = (this.collectedData.desired_outcomes ?? '').toLowerCase();
    const combined = `${context} ${target} ${outcomes}`;

    if (combined.includes('webinar')) {
      return {
        question: 'What deliverable(s) do you need?',
        example: 'e.g., "presentation deck, registration page, 3 promo emails, social posts, recording edit" — list as many as you need',
      };
    }

    if (combined.includes('conference') || combined.includes('trade show') || combined.includes('expo')) {
      return {
        question: 'What deliverable(s) do you need?',
        example: 'e.g., "booth graphics, 1 one-pager, social posts, presentation deck, badge scan follow-up email" — list as many as you need',
      };
    }

    if (combined.includes('dinner') || combined.includes('insider')) {
      return {
        question: 'What deliverable(s) do you need?',
        example: 'e.g., "invitation email, table cards, name tags, follow-up email, event brief" — list as many as you need',
      };
    }

    if (combined.includes('email') || combined.includes('newsletter')) {
      return {
        question: 'What deliverable(s) do you need?',
        example: 'e.g., "email template, subject line options, landing page, social teaser" — list as many as you need',
      };
    }

    if (combined.includes('launch') || combined.includes('campaign')) {
      return {
        question: 'What deliverable(s) do you need?',
        example: 'e.g., "landing page, 3 email templates, social posts, one-pager, press release" — list as many as you need',
      };
    }

    return FIELD_PROMPTS.deliverables;
  }

  /** Generate a context-aware due date prompt based on collected data. */
  private getDueDatePrompt(): { question: string; example: string } {
    const context = (this.collectedData.context_background ?? '').toLowerCase();
    const deliverables = (this.collectedData.deliverables ?? []).join(' ').toLowerCase();

    if (context.includes('conference') || context.includes('trade show') || context.includes('expo')) {
      return {
        question: "When is the conference? I'll work backwards to suggest when materials should be ready.",
        example: 'e.g., "March 10-12", "AHR Expo is January 27"',
      };
    }

    if (context.includes('webinar')) {
      return {
        question: "When are you planning to hold the webinar? I'll factor in time for the registration page and promo.",
        example: 'e.g., "March 15 at 2pm ET", "sometime in April"',
      };
    }

    if (context.includes('dinner') || context.includes('insider')) {
      return {
        question: "When is the dinner? I'll plan backwards for invitations and branding.",
        example: 'e.g., "April 3", "during the conference on March 11"',
      };
    }

    const quickAssets = ['email', 'social', 'graphic', 'one-pager', 'flyer', 'banner', 'headshot', 'photo'];
    const isQuickAsset = quickAssets.some((a) => deliverables.includes(a) || context.includes(a));

    if (isQuickAsset) {
      return {
        question: 'When do you need this by? For single assets, we typically need 1-2 weeks.',
        example: 'e.g., "next Friday", "February 15", "end of month", "ASAP"',
      };
    }

    return {
      question: 'When do you need this by? Quick assets take 1-2 weeks; full campaigns need 4-6 weeks.',
      example: 'e.g., "next Friday", "February 15", "end of month", "ASAP"',
    };
  }

  /** Get items flagged for discussion. */
  getDiscussionFlags(): { field: string; label: string }[] {
    const raw = this.collectedData.additional_details['__needs_discussion'];
    if (!raw) return [];
    try {
      return JSON.parse(raw) as { field: string; label: string }[];
    } catch {
      return [];
    }
  }

  /** True when all required fields have been populated. */
  isComplete(): boolean {
    return REQUIRED_FIELDS.every((f) => isFieldPopulated(this.collectedData, f));
  }

  /** Generate a Slack mrkdwn summary for user confirmation. */
  toSummary(): string {
    const d = this.collectedData;
    let relatedProjects: string[] = [];
    try {
      const raw = d.additional_details['__related_projects'];
      if (raw) relatedProjects = JSON.parse(raw) as string[];
    } catch { /* ignore */ }
    const lines: string[] = [
      ":white_check_mark: *Here's what I've got:*",
      '',
      `• *Requester:* ${d.requester_name ?? '_not provided_'}`,
      `• *Department:* ${d.requester_department ?? '_not provided_'}`,
    ];
    if (relatedProjects.length > 0) {
      lines.push(`• *May be related to:* ${relatedProjects.join(', ')}`);
    }
    lines.push(
      `• *Target audience:* ${d.target ?? '_not provided_'}`,
      `• *Context & background:* ${d.context_background ?? '_not provided_'}`,
      `• *Desired outcomes:* ${d.desired_outcomes ?? '_not provided_'}`,
      `• *Deliverables:* ${d.deliverables.length > 0 ? d.deliverables.join(', ') : '_not provided_'}`,
      `• *Due date:* ${d.due_date ?? '_not provided_'}`,
    );

    if (d.approvals) {
      lines.push(`• *Approvals:* ${d.approvals}`);
    }
    if (d.constraints) {
      lines.push(`• *Constraints:* ${d.constraints}`);
    }
    if (d.supporting_links.length > 0) {
      lines.push(`• *Supporting links:* ${d.supporting_links.join(', ')}`);
    }

    if (d.request_type) {
      lines.push(`• *Request type:* ${d.request_type}`);
    }

    // Show additional details from follow-up questions (skip internal keys)
    const additionalEntries = Object.entries(d.additional_details).filter(
      ([key]) => !key.startsWith('__')
    );
    if (additionalEntries.length > 0) {
      lines.push('');
      lines.push('*Additional details:*');
      for (const [key, value] of additionalEntries) {
        const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        lines.push(`• *${label}:* ${value}`);
      }
    }

    if (d.conference_start_date) {
      lines.push(`• *Conference start:* ${d.conference_start_date}`);
    }
    if (d.conference_end_date) {
      lines.push(`• *Conference end:* ${d.conference_end_date}`);
    }
    if (d.presenter_names) {
      lines.push(`• *Presenter(s):* ${d.presenter_names}`);
    }
    if (d.outside_presenters) {
      lines.push(`• *Outside presenters:* ${d.outside_presenters}`);
    }

    // Show items flagged for discussion
    const discussionFlags = this.getDiscussionFlags();
    // Show existing content/assets
    const existingAssetsRaw = d.additional_details['__existing_assets'];
    if (existingAssetsRaw) {
      try {
        const assets = JSON.parse(existingAssetsRaw) as { link: string; status: string }[];
        if (assets.length > 0) {
          lines.push('');
          lines.push('*Existing content:*');
          for (const asset of assets) {
            lines.push(`• ${asset.link} — _${asset.status}_`);
          }
        }
      } catch { /* ignore parse errors */ }
    } else if (d.additional_details['draft_link'] === '_will share later_') {
      lines.push('• *Existing content:* _will share later_');
    }

    if (discussionFlags.length > 0) {
      lines.push('');
      lines.push(':speech_balloon: *Flagged for discussion:*');
      for (const flag of discussionFlags) {
        lines.push(`• ${formatFieldLabel(flag.label)}`);
      }
    }

    lines.push('');
    lines.push('Does this look right? Reply *yes* to submit, or tell me what to change.');

    return lines.join('\n');
  }

  /** Persist current state to the database. Returns the row id. */
  async save(): Promise<number> {
    const rowId = await upsertConversation({
      id: this.id,
      user_id: this.userId,
      user_name: this.userName,
      channel_id: this.channelId,
      thread_ts: this.threadTs,
      status: this.status,
      current_step: this.currentStep,
      collected_data: JSON.stringify(this.collectedData),
      classification: this.classification,
      monday_item_id: this.mondayItemId,
    });
    this.id = rowId;
    return rowId;
  }

  /** Reset all collected data and return to gathering state.
   *  Preserves requester_name and requester_department so the user isn't re-asked. */
  reset(): void {
    const name = this.collectedData.requester_name;
    const dept = this.collectedData.requester_department;
    this.collectedData = emptyCollectedData();
    this.collectedData.requester_name = name;
    this.collectedData.requester_department = dept;
    this.status = 'gathering';
    this.currentStep = null;
    this.classification = 'undetermined';
    this.mondayItemId = null;
  }
}

// --- Helpers ---

function emptyCollectedData(): CollectedData {
  return {
    requester_name: null,
    requester_department: null,
    target: null,
    context_background: null,
    desired_outcomes: null,
    deliverables: [],
    due_date: null,
    due_date_parsed: null,
    approvals: null,
    constraints: null,
    supporting_links: [],
    request_type: null,
    additional_details: {},
    conference_start_date: null,
    conference_end_date: null,
    presenter_names: null,
    outside_presenters: null,
  };
}

function parseCollectedData(raw: string): CollectedData {
  try {
    const parsed = JSON.parse(raw) as Partial<CollectedData>;
    return {
      requester_name: parsed.requester_name ?? null,
      requester_department: parsed.requester_department ?? null,
      target: parsed.target ?? null,
      context_background: parsed.context_background ?? null,
      desired_outcomes: parsed.desired_outcomes ?? null,
      deliverables: parsed.deliverables ?? [],
      due_date: parsed.due_date ?? null,
      due_date_parsed: parsed.due_date_parsed ?? null,
      approvals: parsed.approvals ?? null,
      constraints: parsed.constraints ?? null,
      supporting_links: parsed.supporting_links ?? [],
      request_type: parsed.request_type ?? null,
      additional_details: parsed.additional_details ?? {},
      conference_start_date: parsed.conference_start_date ?? null,
      conference_end_date: parsed.conference_end_date ?? null,
      presenter_names: parsed.presenter_names ?? null,
      outside_presenters: parsed.outside_presenters ?? null,
    };
  } catch {
    return emptyCollectedData();
  }
}

function isFieldPopulated(data: CollectedData, field: keyof CollectedData): boolean {
  const value = data[field];
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== '';
}

function formatFieldLabel(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Generate a descriptive project name for triage from collected data.
 * e.g., "Webinar Series — Q2 Partner Training" or "Conference — AHR Expo Booth Materials"
 */
export function generateProjectName(data: Partial<CollectedData>): string {
  const requestType = (data as CollectedData).request_type ?? '';
  const context = data.context_background ?? '';
  const deliverables = data.deliverables ?? [];

  // Build type prefix
  const typeLabels: Record<string, string> = {
    conference: 'Conference',
    insider_dinner: 'Insider Dinner',
    webinar: 'Webinar',
    email: 'Email Campaign',
    graphic_design: 'Design',
    general: 'Request',
  };

  // Handle multi-type (comma-separated)
  const types = requestType.split(',').map((t) => t.trim()).filter(Boolean);
  let typePrefix: string;
  if (types.length > 1) {
    typePrefix = types.map((t) => typeLabels[t] ?? t).join(' + ');
  } else if (types.length === 1 && typeLabels[types[0]]) {
    typePrefix = typeLabels[types[0]];
  } else {
    typePrefix = 'Request';
  }

  // Detect "series" or "campaign" modifiers
  const lower = context.toLowerCase();
  if (lower.includes('series')) typePrefix += ' Series';
  else if (lower.includes('campaign') && !typePrefix.includes('Campaign')) typePrefix += ' Campaign';

  // Extract a short descriptor from context (first meaningful phrase)
  let descriptor = '';
  if (context) {
    // Try to get the first sentence or clause
    const firstSentence = context.split(/[.!?\n]/)[0].trim();
    // If it's short enough, use it; otherwise take first ~60 chars at a word boundary
    if (firstSentence.length <= 60) {
      descriptor = firstSentence;
    } else {
      const truncated = firstSentence.slice(0, 60);
      const lastSpace = truncated.lastIndexOf(' ');
      descriptor = lastSpace > 30 ? truncated.slice(0, lastSpace) : truncated;
    }
  } else if (deliverables.length > 0) {
    descriptor = deliverables.slice(0, 3).join(', ');
  }

  if (descriptor) {
    return `${typePrefix} — ${descriptor}`;
  }
  return typePrefix;
}
