import type { CollectedData } from './conversation';

/**
 * Production timeline generator.
 * Works backwards from a target date to suggest specific production dates
 * organized into clear phases: kick-off → marketing creates → requester reviews → target.
 */

type Phase = 'kickoff' | 'create' | 'review' | 'delivery';

interface TimelineTask {
  label: string;
  phase: Phase;
  daysBeforeDeadline: number;
}

interface TimelineEntry {
  task: string;
  phase: Phase;
  date: Date;
}

// --- Task templates by request type ---

const WEBINAR_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 29 },
  { label: 'Email campaign drafts', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Social media content', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Slide deck', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Webinar registration page', phase: 'create', daysBeforeDeadline: 8 },
  { label: 'Review drafts & provide feedback', phase: 'review', daysBeforeDeadline: 12 },
  { label: 'Final approval', phase: 'review', daysBeforeDeadline: 5 },
];

const WEBINAR_ADS_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 43 },
  { label: 'Ad creative & targeting setup', phase: 'create', daysBeforeDeadline: 36 },
  { label: 'Email campaign drafts', phase: 'create', daysBeforeDeadline: 29 },
  { label: 'Social media content', phase: 'create', daysBeforeDeadline: 29 },
  { label: 'Slide deck', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Webinar registration page', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Review drafts & provide feedback', phase: 'review', daysBeforeDeadline: 19 },
  { label: 'Final approval', phase: 'review', daysBeforeDeadline: 12 },
  { label: 'Ad warm-up begins (runs through event)', phase: 'delivery', daysBeforeDeadline: 14 },
];

const CONFERENCE_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 36 },
  { label: 'Print production sent to printer (if needed)', phase: 'create', daysBeforeDeadline: 29 },
  { label: 'Pre-conference email campaign', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Social media promotion', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Booth collateral & signage', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Presentation slides', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Review drafts & provide feedback', phase: 'review', daysBeforeDeadline: 19 },
  { label: 'Final approval on all materials', phase: 'review', daysBeforeDeadline: 8 },
  { label: 'Assets delivered & ready to go', phase: 'delivery', daysBeforeDeadline: 3 },
];

const DINNER_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 29 },
  { label: 'Invitation design & copy', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Event branding & signage', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Email invitation campaign', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Review drafts & provide feedback', phase: 'review', daysBeforeDeadline: 19 },
  { label: 'Final approval', phase: 'review', daysBeforeDeadline: 8 },
  { label: 'Invitations sent', phase: 'delivery', daysBeforeDeadline: 10 },
];

const QUICK_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 15 },
  { label: 'Asset creation', phase: 'create', daysBeforeDeadline: 8 },
  { label: 'Review & approve', phase: 'review', daysBeforeDeadline: 5 },
];

const DEFAULT_TASKS: TimelineTask[] = [
  { label: 'Marketing reviews brief & confirms scope', phase: 'kickoff', daysBeforeDeadline: 29 },
  { label: 'Content & asset development', phase: 'create', daysBeforeDeadline: 22 },
  { label: 'Email & social promotion', phase: 'create', daysBeforeDeadline: 15 },
  { label: 'Review drafts & provide feedback', phase: 'review', daysBeforeDeadline: 12 },
  { label: 'Final approval', phase: 'review', daysBeforeDeadline: 5 },
];

// --- Public API ---

/**
 * Generate a suggested production timeline working backwards from a target date.
 * Returns a formatted Slack mrkdwn string, or null if we can't parse the date.
 */
export function generateProductionTimeline(
  collectedData: Partial<CollectedData>,
): string | null {
  const parsedDate = collectedData.due_date_parsed;
  if (!parsedDate) return null;

  const targetDate = new Date(parsedDate + 'T00:00:00');
  if (isNaN(targetDate.getTime())) return null;

  const context = (collectedData.context_background ?? '').toLowerCase();
  const deliverables = (collectedData.deliverables ?? []).join(' ').toLowerCase();
  const hasAds = deliverables.includes('ad') || context.includes('ad campaign') || context.includes('digital ads') || context.includes('run ads');

  const tasks = selectTasks(context, deliverables, hasAds);
  const entries = calculateDates(targetDate, tasks);

  return formatTimeline(entries, targetDate, collectedData.due_date ?? parsedDate);
}

// --- Internals ---

function selectTasks(context: string, deliverables: string, hasAds: boolean): TimelineTask[] {
  if (context.includes('webinar')) {
    return hasAds ? WEBINAR_ADS_TASKS : WEBINAR_TASKS;
  }
  if (context.includes('conference') || context.includes('trade show') || context.includes('expo')) {
    return CONFERENCE_TASKS;
  }
  if (context.includes('dinner') || context.includes('insider')) {
    return DINNER_TASKS;
  }

  const quickAssets = ['email', 'social post', 'graphic', 'one-pager', 'flyer', 'banner', 'headshot'];
  const isQuick = quickAssets.some((a) => deliverables.includes(a));
  if (isQuick) {
    return QUICK_TASKS;
  }

  return DEFAULT_TASKS;
}

function calculateDates(targetDate: Date, tasks: TimelineTask[]): TimelineEntry[] {
  return tasks.map((task) => {
    const date = new Date(targetDate);
    date.setDate(date.getDate() - task.daysBeforeDeadline);
    return {
      task: task.label,
      phase: task.phase,
      date,
    };
  });
}

function formatTimeline(entries: TimelineEntry[], targetDate: Date, userDateLabel: string): string {
  const lines: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  lines.push(`:calendar: *Suggested production timeline* (working back from ${userDateLabel}):\n`);

  // Group entries by phase
  const phases: { key: Phase; header: string; emoji: string }[] = [
    { key: 'kickoff', header: 'Project kick-off', emoji: ':clipboard:' },
    { key: 'create', header: 'Marketing creates', emoji: ':art:' },
    { key: 'review', header: 'Your review & approval', emoji: ':mag:' },
    { key: 'delivery', header: 'Go live', emoji: ':rocket:' },
  ];

  let hasPastDates = false;

  for (const phase of phases) {
    const phaseEntries = entries
      .filter((e) => e.phase === phase.key)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    if (phaseEntries.length === 0) continue;

    lines.push(`${phase.emoji} *${phase.header}*`);
    for (const entry of phaseEntries) {
      const dateStr = formatDate(entry.date);
      const isPast = entry.date < today;
      if (isPast) hasPastDates = true;
      const marker = isPast ? ' :warning:' : '';
      lines.push(`  • By ${dateStr} — ${entry.task}${marker}`);
    }
    lines.push('');
  }

  lines.push(`:dart: *${formatDate(targetDate)}* — Target date`);

  if (hasPastDates) {
    lines.push('\n:warning: Some dates are in the past — this timeline is tight! We may need to adjust scope or the target date.');
  }

  lines.push('\nDoes this timeline work for you? We can adjust if needed.');

  return lines.join('\n');
}

function formatDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };
  return date.toLocaleDateString('en-US', options);
}
