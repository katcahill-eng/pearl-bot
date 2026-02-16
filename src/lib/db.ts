import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
  min: 1,
  idleTimeoutMillis: 30000,
});

// Prevent idle client errors from crashing the process
pool.on('error', (err) => {
  console.error('[db] Unexpected pool error on idle client:', err);
});

// --- Instance leader lock ---
// During rolling deploys, two instances may run simultaneously.
// Only the latest instance (leader) should process events.
const INSTANCE_ID = randomUUID();

// --- Schema init ---

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'gathering' CHECK(status IN ('gathering','confirming','pending_approval','complete','cancelled','withdrawn')),
      current_step TEXT,
      collected_data JSONB NOT NULL DEFAULT '{}',
      classification TEXT DEFAULT 'undetermined' CHECK(classification IN ('quick','full','undetermined')),
      monday_item_id TEXT,
      triage_message_ts TEXT,
      triage_channel_id TEXT,
      timeout_notified INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
    );

    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('quick','full')),
      requester_name TEXT NOT NULL,
      requester_slack_id TEXT NOT NULL,
      requester_email TEXT,
      division TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      drive_folder_url TEXT,
      brief_doc_url TEXT,
      monday_item_id TEXT,
      monday_url TEXT,
      source TEXT NOT NULL DEFAULT 'conversation' CHECK(source IN ('conversation','form')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      due_date TEXT
    );

    CREATE TABLE IF NOT EXISTS divisions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slack_channel TEXT
    );

    CREATE TABLE IF NOT EXISTS message_dedup (
      message_ts TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_instance (
      id INTEGER PRIMARY KEY DEFAULT 1,
      instance_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id SERIAL PRIMARY KEY,
      error_key TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      context JSONB DEFAULT '{}',
      instance_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS unrecognized_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER,
      user_message TEXT NOT NULL,
      current_step TEXT,
      confidence REAL,
      fields_extracted INTEGER NOT NULL DEFAULT 0,
      raw_fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_metrics (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      final_status TEXT NOT NULL,
      duration_seconds INTEGER,
      classification TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bot_improvements (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('pattern','prompt','flow','bug')),
      summary TEXT NOT NULL,
      details TEXT NOT NULL,
      evidence JSONB DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),
      applied_by TEXT,
      applied_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Register this instance as the active leader
  await pool.query(
    `INSERT INTO bot_instance (id, instance_id, started_at) VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET instance_id = $1, started_at = NOW()`,
    [INSTANCE_ID]
  );
  console.log(`[db] Registered as leader instance: ${INSTANCE_ID.substring(0, 8)}`);

  // Clean up old dedup entries (older than 1 hour)
  await pool.query(`DELETE FROM message_dedup WHERE created_at < NOW() - INTERVAL '1 hour'`);

  // Clean up stale conversations on startup — cancel any that are expired or
  // have been stuck in active states for over 24 hours (covers deploy gaps)
  const staleResult = await pool.query(
    `UPDATE conversations SET status = 'cancelled', updated_at = NOW()
     WHERE status IN ('gathering', 'confirming')
       AND (expires_at < NOW() OR updated_at < NOW() - INTERVAL '24 hours')`
  );
  if (staleResult.rowCount && staleResult.rowCount > 0) {
    console.log(`[db] Cleaned up ${staleResult.rowCount} stale conversation(s) on startup`);
  }
}

// --- Types ---

export interface Conversation {
  id: number;
  user_id: string;
  user_name: string;
  channel_id: string;
  thread_ts: string;
  status: 'gathering' | 'confirming' | 'pending_approval' | 'complete' | 'cancelled' | 'withdrawn';
  current_step: string | null;
  collected_data: string;
  classification: 'quick' | 'full' | 'undetermined';
  monday_item_id: string | null;
  triage_message_ts: string | null;
  triage_channel_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  timeout_notified: number;
}

export interface Project {
  id: number;
  name: string;
  type: 'quick' | 'full';
  requester_name: string;
  requester_slack_id: string;
  requester_email: string | null;
  division: string | null;
  status: string;
  drive_folder_url: string | null;
  brief_doc_url: string | null;
  monday_item_id: string | null;
  monday_url: string | null;
  source: 'conversation' | 'form';
  created_at: string;
  due_date: string | null;
}

export interface Division {
  id: number;
  name: string;
  slack_channel: string | null;
}

// --- Helper to normalize row ---

function normalizeConversationRow(row: any): Conversation {
  return {
    ...row,
    collected_data: typeof row.collected_data === 'object'
      ? JSON.stringify(row.collected_data)
      : row.collected_data,
  };
}

// --- Helper Functions ---

export async function getConversation(userId: string, threadTs: string): Promise<Conversation | undefined> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE thread_ts = $1
     ORDER BY CASE WHEN status IN ('gathering','confirming','pending_approval') THEN 0 ELSE 1 END,
              updated_at DESC
     LIMIT 1`,
    [threadTs]
  );
  return result.rows[0] ? normalizeConversationRow(result.rows[0]) : undefined;
}

/** Check if any conversation (any status) has ever existed in this thread. */
export async function hasConversationInThread(threadTs: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM conversations WHERE thread_ts = $1 LIMIT 1`,
    [threadTs]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getConversationById(id: number): Promise<Conversation | undefined> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? normalizeConversationRow(result.rows[0]) : undefined;
}

export async function upsertConversation(data: {
  id?: number;
  user_id: string;
  user_name: string;
  channel_id: string;
  thread_ts: string;
  status: Conversation['status'];
  current_step: string | null;
  collected_data: string;
  classification: Conversation['classification'];
  monday_item_id?: string | null;
}): Promise<number> {
  if (data.id) {
    await pool.query(
      `UPDATE conversations
       SET status = $1,
           current_step = $2,
           collected_data = $3,
           classification = $4,
           monday_item_id = $5,
           updated_at = NOW(),
           expires_at = NOW() + INTERVAL '24 hours'
       WHERE id = $6`,
      [data.status, data.current_step, data.collected_data, data.classification, data.monday_item_id ?? null, data.id]
    );
    return data.id;
  }
  const result = await pool.query(
    `INSERT INTO conversations (user_id, user_name, channel_id, thread_ts, status, current_step, collected_data, classification, monday_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [data.user_id, data.user_name, data.channel_id, data.thread_ts, data.status, data.current_step, data.collected_data, data.classification, data.monday_item_id ?? null]
  );
  return result.rows[0].id;
}

export async function createProject(data: {
  name: string;
  type: Project['type'];
  requester_name: string;
  requester_slack_id: string;
  requester_email?: string | null;
  division?: string | null;
  status?: string;
  drive_folder_url?: string | null;
  brief_doc_url?: string | null;
  monday_item_id?: string | null;
  monday_url?: string | null;
  source?: Project['source'];
  due_date?: string | null;
}): Promise<number> {
  const result = await pool.query(
    `INSERT INTO projects (name, type, requester_name, requester_slack_id, requester_email, division, status, drive_folder_url, brief_doc_url, monday_item_id, monday_url, source, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      data.name,
      data.type,
      data.requester_name,
      data.requester_slack_id,
      data.requester_email ?? null,
      data.division ?? null,
      data.status ?? 'new',
      data.drive_folder_url ?? null,
      data.brief_doc_url ?? null,
      data.monday_item_id ?? null,
      data.monday_url ?? null,
      data.source ?? 'conversation',
      data.due_date ?? null,
    ]
  );
  return result.rows[0].id;
}

export async function getProject(id: number): Promise<Project | undefined> {
  const result = await pool.query(
    `SELECT * FROM projects WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? undefined;
}

export async function searchProjects(query: string): Promise<Project[]> {
  const result = await pool.query(
    `SELECT * FROM projects WHERE name ILIKE $1 ORDER BY created_at DESC LIMIT 20`,
    [`%${query}%`]
  );
  return result.rows;
}

export async function getTimedOutConversations(): Promise<Conversation[]> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE status IN ('gathering', 'confirming') AND expires_at <= NOW() AND timeout_notified = 0`
  );
  return result.rows.map(normalizeConversationRow);
}

export async function getAutoCancelConversations(): Promise<Conversation[]> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE status IN ('gathering', 'confirming') AND expires_at <= NOW() AND timeout_notified = 1`
  );
  return result.rows.map(normalizeConversationRow);
}

export async function markTimeoutNotified(id: number): Promise<void> {
  await pool.query(
    `UPDATE conversations SET timeout_notified = 1, expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function cancelConversation(id: number): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function cancelStaleConversationsForUser(userId: string, excludeThreadTs: string): Promise<number> {
  const result = await pool.query(
    `UPDATE conversations SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status IN ('gathering', 'confirming') AND thread_ts != $2`,
    [userId, excludeThreadTs]
  );
  return result.rowCount ?? 0;
}

export async function getActiveConversationForUser(userId: string, excludeThreadTs: string): Promise<Conversation | undefined> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE user_id = $1 AND status IN ('gathering', 'confirming', 'pending_approval') AND thread_ts != $2 ORDER BY updated_at DESC LIMIT 1`,
    [userId, excludeThreadTs]
  );
  return result.rows[0] ? normalizeConversationRow(result.rows[0]) : undefined;
}

export async function updateMondayItemId(conversationId: number, itemId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET monday_item_id = $1, updated_at = NOW() WHERE id = $2`,
    [itemId, conversationId]
  );
}

export async function updateTriageInfo(conversationId: number, messageTs: string, channelId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET triage_message_ts = $1, triage_channel_id = $2, updated_at = NOW() WHERE id = $3`,
    [messageTs, channelId, conversationId]
  );
}

/** Returns true if this message was already processed (by another container). */
export async function isMessageProcessed(messageTs: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO message_dedup (message_ts) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_ts`,
    [messageTs]
  );
  // If INSERT returned a row, we claimed it (not processed before). If 0 rows, already exists.
  return result.rowCount === 0;
}

// --- Instance leader lock ---

/** Returns true if this instance is the current leader (latest to start). */
export async function isCurrentLeader(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT instance_id FROM bot_instance WHERE id = 1');
    return result.rows[0]?.instance_id === INSTANCE_ID;
  } catch {
    // Fail open — if DB check fails, assume we're leader to avoid dropping events
    return true;
  }
}

export function getInstanceId(): string {
  return INSTANCE_ID;
}

// --- Error tracking ---

/**
 * Log an error to the database. Returns the error count for the same key
 * in the last hour (for spike detection).
 */
export async function logError(
  error: unknown,
  context?: Record<string, string>,
): Promise<number> {
  const err = error instanceof Error ? error : new Error(String(error));
  // Use the first line of the stack (or message) as the dedup key
  const errorKey = (err.stack?.split('\n')[0] ?? err.message).substring(0, 200);

  try {
    await pool.query(
      `INSERT INTO error_log (error_key, message, stack, context, instance_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [errorKey, err.message, err.stack ?? null, JSON.stringify(context ?? {}), INSTANCE_ID]
    );
    // Count how many times this same error happened in the last hour
    const countResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM error_log WHERE error_key = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [errorKey]
    );
    return parseInt(countResult.rows[0]?.cnt ?? '1', 10);
  } catch (dbErr) {
    // If error logging itself fails, just console log — don't throw
    console.error('[error-tracker] Failed to log error to DB:', dbErr);
    return 0;
  }
}

/** Get recent errors, grouped by key with counts. */
export async function getRecentErrors(hours = 24, limit = 50): Promise<{
  error_key: string;
  message: string;
  count: number;
  last_seen: string;
  last_stack: string | null;
  last_context: Record<string, string>;
}[]> {
  const result = await pool.query(
    `SELECT error_key,
            MAX(message) as message,
            COUNT(*) as count,
            MAX(created_at) as last_seen,
            (array_agg(stack ORDER BY created_at DESC))[1] as last_stack,
            (array_agg(context ORDER BY created_at DESC))[1] as last_context
     FROM error_log
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     GROUP BY error_key
     ORDER BY count DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((r: any) => ({
    error_key: r.error_key,
    message: r.message,
    count: parseInt(r.count, 10),
    last_seen: r.last_seen,
    last_stack: r.last_stack,
    last_context: r.last_context ?? {},
  }));
}

/** Clean up old error logs. */
export async function cleanOldErrors(daysToKeep = 7): Promise<number> {
  const result = await pool.query(
    `DELETE FROM error_log WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
  );
  return result.rowCount ?? 0;
}

// --- Self-improvement tracking ---

/** Log a message where Claude couldn't extract fields. */
export async function logUnrecognizedMessage(data: {
  conversationId?: number;
  userMessage: string;
  currentStep: string | null;
  confidence: number;
  fieldsExtracted: number;
  rawFallbackUsed: boolean;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO unrecognized_messages (conversation_id, user_message, current_step, confidence, fields_extracted, raw_fallback_used)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [data.conversationId ?? null, data.userMessage, data.currentStep, data.confidence, data.fieldsExtracted, data.rawFallbackUsed]
    );
  } catch (err) {
    console.error('[db] Failed to log unrecognized message:', err);
  }
}

/** Log conversation outcome metrics. */
export async function logConversationMetrics(data: {
  conversationId: number;
  userId: string;
  finalStatus: string;
  durationSeconds: number | null;
  classification: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO conversation_metrics (conversation_id, user_id, final_status, duration_seconds, classification)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.conversationId, data.userId, data.finalStatus, data.durationSeconds, data.classification]
    );
  } catch (err) {
    console.error('[db] Failed to log conversation metrics:', err);
  }
}

/** Create a bot improvement suggestion. */
export async function createImprovement(data: {
  category: 'pattern' | 'prompt' | 'flow' | 'bug';
  summary: string;
  details: string;
  evidence?: Record<string, unknown>;
}): Promise<number> {
  const result = await pool.query(
    `INSERT INTO bot_improvements (category, summary, details, evidence)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [data.category, data.summary, data.details, JSON.stringify(data.evidence ?? {})]
  );
  return result.rows[0].id;
}

/** Get improvements filtered by status. */
export async function getImprovements(status?: 'pending' | 'applied' | 'dismissed'): Promise<{
  id: number;
  category: string;
  summary: string;
  details: string;
  evidence: Record<string, unknown>;
  status: string;
  applied_by: string | null;
  applied_at: string | null;
  created_at: string;
}[]> {
  const query = status
    ? `SELECT * FROM bot_improvements WHERE status = $1 ORDER BY created_at DESC LIMIT 50`
    : `SELECT * FROM bot_improvements ORDER BY created_at DESC LIMIT 50`;
  const params = status ? [status] : [];
  const result = await pool.query(query, params);
  return result.rows.map((r: any) => ({
    id: r.id,
    category: r.category,
    summary: r.summary,
    details: r.details,
    evidence: r.evidence ?? {},
    status: r.status,
    applied_by: r.applied_by,
    applied_at: r.applied_at,
    created_at: r.created_at,
  }));
}

/** Update an improvement's status. */
export async function updateImprovementStatus(
  id: number,
  status: 'applied' | 'dismissed',
  appliedBy?: string,
): Promise<void> {
  await pool.query(
    `UPDATE bot_improvements SET status = $1, applied_by = $2, applied_at = NOW() WHERE id = $3`,
    [status, appliedBy ?? null, id]
  );
}

/** Get recent unrecognized messages for analysis. */
export async function getRecentUnrecognizedMessages(days = 7, limit = 100): Promise<{
  user_message: string;
  current_step: string | null;
  confidence: number;
  fields_extracted: number;
  raw_fallback_used: boolean;
  created_at: string;
}[]> {
  const result = await pool.query(
    `SELECT user_message, current_step, confidence, fields_extracted, raw_fallback_used, created_at
     FROM unrecognized_messages
     WHERE created_at > NOW() - INTERVAL '${days} days'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Get conversation metrics summary for analysis. */
export async function getConversationMetricsSummary(days = 7): Promise<{
  total: number;
  byStatus: Record<string, number>;
  avgDurationSeconds: number | null;
  byClassification: Record<string, number>;
}> {
  const statusResult = await pool.query(
    `SELECT final_status, COUNT(*) as cnt
     FROM conversation_metrics
     WHERE created_at > NOW() - INTERVAL '${days} days'
     GROUP BY final_status`
  );
  const durationResult = await pool.query(
    `SELECT AVG(duration_seconds) as avg_dur
     FROM conversation_metrics
     WHERE created_at > NOW() - INTERVAL '${days} days'
       AND duration_seconds IS NOT NULL`
  );
  const classResult = await pool.query(
    `SELECT classification, COUNT(*) as cnt
     FROM conversation_metrics
     WHERE created_at > NOW() - INTERVAL '${days} days'
       AND classification IS NOT NULL
     GROUP BY classification`
  );

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of statusResult.rows) {
    const count = parseInt(row.cnt, 10);
    byStatus[row.final_status] = count;
    total += count;
  }

  const byClassification: Record<string, number> = {};
  for (const row of classResult.rows) {
    byClassification[row.classification] = parseInt(row.cnt, 10);
  }

  return {
    total,
    byStatus,
    avgDurationSeconds: durationResult.rows[0]?.avg_dur ? parseFloat(durationResult.rows[0].avg_dur) : null,
    byClassification,
  };
}

/** Clean up old metrics data. */
export async function cleanOldMetrics(daysToKeep = 30): Promise<number> {
  const r1 = await pool.query(
    `DELETE FROM unrecognized_messages WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
  );
  const r2 = await pool.query(
    `DELETE FROM conversation_metrics WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
  );
  return (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
}

/** Get conversations that were cancelled (timed out / abandoned) in the last N hours. */
export async function getAbandonedConversations(hours = 24): Promise<{
  user_id: string;
  user_name: string;
  current_step: string | null;
  updated_at: string;
}[]> {
  const result = await pool.query(
    `SELECT user_id, user_name, current_step, updated_at
     FROM conversations
     WHERE status = 'cancelled'
       AND updated_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY updated_at DESC`
  );
  return result.rows;
}
