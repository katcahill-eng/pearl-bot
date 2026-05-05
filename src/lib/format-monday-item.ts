/**
 * Requester-attribution formatter for Sage v2.
 *
 * Every Sage report or list that surfaces Monday items must show who
 * requested the item and when — per PRD US-006. This helper normalizes
 * that copy across status replies, search results, lifecycle replies,
 * and the weekly digest.
 *
 * Caller resolves the requester's display name (typically via
 * slack-users.ts) before passing the item in; if the requester can't
 * be resolved, pass requesterName: null and the helper produces a
 * graceful "requester not on file" line instead of erroring.
 */

export interface MondayItemAttribution {
  /** Resolved display name of the requester, or null if not on file. */
  requesterName: string | null;
  /** Date the request was created (string accepted; parsed via new Date()). */
  requestedDate: Date | string;
  /**
   * Optional: when set, the request was filed on someone else's behalf.
   * Renders as "requesting for {name}" suffix.
   */
  requestingForName?: string | null;
}

/**
 * Format a one-line attribution string for a Monday item.
 *
 * Examples:
 *   "Requested by Casey on Apr 19"
 *   "Requested by Casey on Apr 19 · requesting for Sean"
 *   "Requested Apr 19 · requester not on file"
 */
export function formatItemAttribution(item: MondayItemAttribution): string {
  const date = formatShortDate(item.requestedDate);

  if (!item.requesterName) {
    return `Requested ${date} · requester not on file`;
  }

  const base = `Requested by ${item.requesterName} on ${date}`;

  if (item.requestingForName) {
    return `${base} · requesting for ${item.requestingForName}`;
  }

  return base;
}

/**
 * Format a date as "MMM d" (e.g. "Apr 19"). Always uses en-US locale so
 * the output is stable across deploy environments.
 */
function formatShortDate(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return 'unknown date';
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}
