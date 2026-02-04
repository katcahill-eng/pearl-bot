import type { CollectedData } from './conversation';

/**
 * Production timeline generator.
 * Works backwards from a target date to suggest specific production dates
 * for each task, using 1-week blocks per task as default durations.
 */

interface TimelineTask {
  label: string;
  daysBeforeDeadline: number; // start this many business days before the deliverable deadline
  duration: string; // human-readable duration
}

interface TimelineEntry {
  task: string;
  startBy: Date;
  duration: string;
}

// --- Task templates by request type ---

const WEBINAR_TASKS: TimelineTask[] = [
  { label: 'Webinar registration page', daysBeforeDeadline: 1, duration: '1 day' },
  { label: 'Slide deck development', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Email campaign creation', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Social media content', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Stakeholder approvals', daysBeforeDeadline: 22, duration: '1 week' },
];

const WEBINAR_ADS_TASKS: TimelineTask[] = [
  { label: 'Webinar registration page', daysBeforeDeadline: 1, duration: '1 day' },
  { label: 'Slide deck development', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Email campaign creation', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Social media content', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Ad creative & setup', daysBeforeDeadline: 22, duration: '1 week' },
  { label: 'Stakeholder approvals', daysBeforeDeadline: 29, duration: '1 week' },
  { label: 'Ad warm-up period', daysBeforeDeadline: 36, duration: '2 weeks' },
];

const CONFERENCE_TASKS: TimelineTask[] = [
  { label: 'Final asset delivery', daysBeforeDeadline: 1, duration: '—' },
  { label: 'Booth collateral & signage', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Presentation slides', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Pre-conference email campaign', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Social media promotion', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Stakeholder approvals', daysBeforeDeadline: 22, duration: '1 week' },
  { label: 'Print production (if needed)', daysBeforeDeadline: 29, duration: '1 week' },
];

const DINNER_TASKS: TimelineTask[] = [
  { label: 'Final asset delivery', daysBeforeDeadline: 1, duration: '—' },
  { label: 'Invitation design & copy', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Event branding & signage', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Email invitation campaign', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Stakeholder approvals', daysBeforeDeadline: 22, duration: '1 week' },
];

const QUICK_TASKS: TimelineTask[] = [
  { label: 'Final delivery', daysBeforeDeadline: 1, duration: '—' },
  { label: 'Asset creation', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Approvals', daysBeforeDeadline: 15, duration: '1 week' },
];

const DEFAULT_TASKS: TimelineTask[] = [
  { label: 'Final delivery', daysBeforeDeadline: 1, duration: '—' },
  { label: 'Content/asset development', daysBeforeDeadline: 8, duration: '1 week' },
  { label: 'Email & social promotion', daysBeforeDeadline: 15, duration: '1 week' },
  { label: 'Stakeholder approvals', daysBeforeDeadline: 22, duration: '1 week' },
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

  // Check for quick/simple assets
  const quickAssets = ['email', 'social post', 'graphic', 'one-pager', 'flyer', 'banner', 'headshot'];
  const isQuick = quickAssets.some((a) => deliverables.includes(a));
  if (isQuick) {
    return QUICK_TASKS;
  }

  return DEFAULT_TASKS;
}

function calculateDates(targetDate: Date, tasks: TimelineTask[]): TimelineEntry[] {
  return tasks.map((task) => {
    const startBy = new Date(targetDate);
    startBy.setDate(startBy.getDate() - task.daysBeforeDeadline);
    return {
      task: task.label,
      startBy,
      duration: task.duration,
    };
  });
}

function formatTimeline(entries: TimelineEntry[], targetDate: Date, userDateLabel: string): string {
  const lines: string[] = [];

  lines.push(`:calendar: *Suggested production timeline* (working back from ${userDateLabel}):\n`);

  // Sort entries by date ascending (earliest first)
  const sorted = [...entries].sort((a, b) => a.startBy.getTime() - b.startBy.getTime());

  // Check if the earliest task is in the past
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const earliestStart = sorted[0]?.startBy;
  const isTight = earliestStart && earliestStart < today;

  for (const entry of sorted) {
    const dateStr = formatDate(entry.startBy);
    const isPast = entry.startBy < today;
    const marker = isPast ? ' :warning:' : '';
    lines.push(`• *${dateStr}* — ${entry.task} (${entry.duration})${marker}`);
  }
  lines.push(`• *${formatDate(targetDate)}* — :dart: Target date`);

  if (isTight) {
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
