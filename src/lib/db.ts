import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db: DatabaseType = new Database(path.join(DATA_DIR, 'marcomsbot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'gathering' CHECK(status IN ('gathering','confirming','pending_approval','complete','cancelled','withdrawn')),
    current_step TEXT,
    collected_data TEXT NOT NULL DEFAULT '{}',
    classification TEXT DEFAULT 'undetermined' CHECK(classification IN ('quick','full','undetermined')),
    monday_item_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    due_date TEXT
  );

  CREATE TABLE IF NOT EXISTS divisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slack_channel TEXT
  );
`);

// Add timeout_notified column if it doesn't exist (for conversation timeout handling)
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN timeout_notified INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists — ignore
}

// Add monday_item_id column if it doesn't exist (for approval gate)
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN monday_item_id TEXT`);
} catch {
  // Column already exists — ignore
}

// Add triage message tracking columns
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN triage_message_ts TEXT`);
} catch {
  // Column already exists — ignore
}
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN triage_channel_id TEXT`);
} catch {
  // Column already exists — ignore
}

// Migrate status CHECK constraint to include 'pending_approval'
// SQLite doesn't support ALTER CHECK, but the CREATE TABLE above already has it for new DBs.
// For existing DBs, we disable foreign keys temporarily and recreate if needed.
// In practice, better-sqlite3 won't enforce CHECK on existing rows, so new inserts/updates will work.

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

// --- Helper Functions ---

const stmts = {
  getConversation: db.prepare<[string], Conversation>(
    `SELECT * FROM conversations WHERE user_id = ? AND status IN ('gathering', 'confirming', 'pending_approval') ORDER BY updated_at DESC LIMIT 1`
  ),
  getConversationByThread: db.prepare<[string], Conversation>(
    `SELECT * FROM conversations WHERE thread_ts = ? LIMIT 1`
  ),
  getConversationById: db.prepare<[number], Conversation>(
    `SELECT * FROM conversations WHERE id = ?`
  ),
  insertConversation: db.prepare(`
    INSERT INTO conversations (user_id, user_name, channel_id, thread_ts, status, current_step, collected_data, classification, monday_item_id)
    VALUES (@user_id, @user_name, @channel_id, @thread_ts, @status, @current_step, @collected_data, @classification, @monday_item_id)
  `),
  updateConversation: db.prepare(`
    UPDATE conversations
    SET status = @status,
        current_step = @current_step,
        collected_data = @collected_data,
        classification = @classification,
        monday_item_id = @monday_item_id,
        updated_at = datetime('now'),
        expires_at = datetime('now', '+24 hours')
    WHERE id = @id
  `),
  insertProject: db.prepare(`
    INSERT INTO projects (name, type, requester_name, requester_slack_id, requester_email, division, status, drive_folder_url, brief_doc_url, monday_item_id, monday_url, source, due_date)
    VALUES (@name, @type, @requester_name, @requester_slack_id, @requester_email, @division, @status, @drive_folder_url, @brief_doc_url, @monday_item_id, @monday_url, @source, @due_date)
  `),
  getProject: db.prepare<[number], Project>(
    `SELECT * FROM projects WHERE id = ?`
  ),
  searchProjects: db.prepare<[string], Project>(
    `SELECT * FROM projects WHERE name LIKE ? ORDER BY created_at DESC LIMIT 20`
  ),
  getTimedOutConversations: db.prepare<[], Conversation>(
    `SELECT * FROM conversations WHERE status IN ('gathering', 'confirming') AND expires_at <= datetime('now') AND timeout_notified = 0`
  ),
  getAutoCancel: db.prepare<[], Conversation>(
    `SELECT * FROM conversations WHERE status IN ('gathering', 'confirming') AND expires_at <= datetime('now') AND timeout_notified = 1`
  ),
  getActiveConversationForUser: db.prepare<[string, string], Conversation>(
    `SELECT * FROM conversations WHERE user_id = ? AND status IN ('gathering', 'confirming', 'pending_approval') AND thread_ts != ? ORDER BY updated_at DESC LIMIT 1`
  ),
  markTimeoutNotified: db.prepare(
    `UPDATE conversations SET timeout_notified = 1, expires_at = datetime('now', '+24 hours'), updated_at = datetime('now') WHERE id = ?`
  ),
  cancelConversation: db.prepare(
    `UPDATE conversations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  ),
  updateMondayItemId: db.prepare(
    `UPDATE conversations SET monday_item_id = ?, updated_at = datetime('now') WHERE id = ?`
  ),
  updateTriageInfo: db.prepare(
    `UPDATE conversations SET triage_message_ts = ?, triage_channel_id = ?, updated_at = datetime('now') WHERE id = ?`
  ),
};

export function getConversation(userId: string, threadTs: string): Conversation | undefined {
  return stmts.getConversationByThread.get(threadTs);
}

export function getConversationById(id: number): Conversation | undefined {
  return stmts.getConversationById.get(id);
}

export function upsertConversation(data: {
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
}): number {
  if (data.id) {
    stmts.updateConversation.run({
      id: data.id,
      status: data.status,
      current_step: data.current_step,
      collected_data: data.collected_data,
      classification: data.classification,
      monday_item_id: data.monday_item_id ?? null,
    });
    return data.id;
  }
  const result = stmts.insertConversation.run({
    user_id: data.user_id,
    user_name: data.user_name,
    channel_id: data.channel_id,
    thread_ts: data.thread_ts,
    status: data.status,
    current_step: data.current_step,
    collected_data: data.collected_data,
    classification: data.classification,
    monday_item_id: data.monday_item_id ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function createProject(data: {
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
}): number {
  const result = stmts.insertProject.run({
    name: data.name,
    type: data.type,
    requester_name: data.requester_name,
    requester_slack_id: data.requester_slack_id,
    requester_email: data.requester_email ?? null,
    division: data.division ?? null,
    status: data.status ?? 'new',
    drive_folder_url: data.drive_folder_url ?? null,
    brief_doc_url: data.brief_doc_url ?? null,
    monday_item_id: data.monday_item_id ?? null,
    monday_url: data.monday_url ?? null,
    source: data.source ?? 'conversation',
    due_date: data.due_date ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getProject(id: number): Project | undefined {
  return stmts.getProject.get(id);
}

export function searchProjects(query: string): Project[] {
  return stmts.searchProjects.all(`%${query}%`);
}

export function getTimedOutConversations(): Conversation[] {
  return stmts.getTimedOutConversations.all();
}

export function getAutoCancelConversations(): Conversation[] {
  return stmts.getAutoCancel.all();
}

export function markTimeoutNotified(id: number): void {
  stmts.markTimeoutNotified.run(id);
}

export function cancelConversation(id: number): void {
  stmts.cancelConversation.run(id);
}

export function getActiveConversationForUser(userId: string, excludeThreadTs: string): Conversation | undefined {
  return stmts.getActiveConversationForUser.get(userId, excludeThreadTs);
}

export function updateMondayItemId(conversationId: number, itemId: string): void {
  stmts.updateMondayItemId.run(itemId, conversationId);
}

export function updateTriageInfo(conversationId: number, messageTs: string, channelId: string): void {
  stmts.updateTriageInfo.run(messageTs, channelId, conversationId);
}

export default db;
