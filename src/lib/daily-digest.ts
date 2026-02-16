import type { WebClient } from '@slack/web-api';
import { config } from './config';
import {
  getRecentErrors,
  getImprovements,
  getConversationMetricsSummary,
  getRecentUnrecognizedMessages,
} from './db';

/**
 * Send a daily digest DM to the marketing lead summarizing
 * bot health, errors, conversations, and self-improvement activity.
 */
export async function sendDailyDigest(client: WebClient): Promise<void> {
  const now = new Date();
  const dateLabel = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const [errors, pending, applied, dismissed, metrics, unrecognized] =
    await Promise.all([
      getRecentErrors(24, 10),
      getImprovements('pending'),
      getRecentImprovements('applied', 24),
      getRecentImprovements('dismissed', 24),
      getConversationMetricsSummary(1),
      getRecentUnrecognizedMessages(1, 10),
    ]);

  const sections: string[] = [
    `:bar_chart: *Daily Bot Digest* — ${dateLabel}`,
    '',
  ];

  // --- Errors ---
  if (errors.length === 0) {
    sections.push('*Errors (24h):* None :white_check_mark:');
  } else {
    sections.push(`*Errors (24h):* ${errors.length} unique`);
    for (const e of errors.slice(0, 5)) {
      sections.push(`  • \`${e.error_key}\` — ${e.count}x — ${truncate(e.message, 80)}`);
    }
  }
  sections.push('');

  // --- Conversations ---
  if (metrics.total === 0) {
    sections.push('*Conversations (24h):* None');
  } else {
    const statusParts = Object.entries(metrics.byStatus)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');
    sections.push(`*Conversations (24h):* ${metrics.total} total — ${statusParts}`);
    if (Object.keys(metrics.byClassification).length > 0) {
      const classParts = Object.entries(metrics.byClassification)
        .map(([c, n]) => `${n} ${c}`)
        .join(', ');
      sections.push(`  By type: ${classParts}`);
    }
  }
  sections.push('');

  // --- Unrecognized Messages ---
  if (unrecognized.length === 0) {
    sections.push('*Unrecognized Messages (24h):* None :white_check_mark:');
  } else {
    sections.push(`*Unrecognized Messages (24h):* ${unrecognized.length}`);
    for (const m of unrecognized.slice(0, 5)) {
      const step = m.current_step ?? '?';
      sections.push(`  • [${step}] "${truncate(m.user_message, 60)}" (confidence=${m.confidence})`);
    }
  }
  sections.push('');

  // --- Bot Learning ---
  sections.push('*Bot Learning:*');
  if (pending.length > 0) {
    sections.push(`  ${pending.length} pending improvement${pending.length === 1 ? '' : 's'}:`);
    for (const imp of pending.slice(0, 5)) {
      sections.push(`  • [${imp.category}] ${truncate(imp.summary, 80)}`);
    }
  } else {
    sections.push('  No pending improvements');
  }
  if (applied.length > 0) {
    sections.push(`  ${applied.length} applied in last 24h`);
  }
  if (dismissed.length > 0) {
    sections.push(`  ${dismissed.length} dismissed in last 24h`);
  }

  // --- Footer ---
  const isClean =
    errors.length === 0 &&
    unrecognized.length === 0 &&
    pending.length === 0;

  sections.push('');
  sections.push(
    isClean
      ? '_All clear — no action needed._ :seedling:'
      : '_Review pending items when you have a moment._',
  );

  const message = sections.join('\n');

  // Send DM to marketing lead
  const dmResult = await client.conversations.open({
    users: config.marketingLeadSlackId,
  });
  const channelId = dmResult.channel?.id;
  if (!channelId) {
    console.error('[daily-digest] Could not open DM with marketing lead');
    return;
  }

  await client.chat.postMessage({
    channel: channelId,
    text: message,
  });

  console.log('[daily-digest] Sent daily digest to marketing lead');
}

// --- Helpers ---

/** Get improvements with a specific status that were updated in the last N hours. */
async function getRecentImprovements(
  status: 'applied' | 'dismissed',
  hours: number,
): Promise<{ id: number; category: string; summary: string }[]> {
  const all = await getImprovements(status);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  return all.filter((imp) => imp.applied_at && new Date(imp.applied_at) > cutoff);
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.substring(0, maxLen - 1) + '…' : str;
}
