/**
 * CJS preload script that replaces pg.Pool with an in-memory mock.
 * Usage: npx tsx --require ./test-pg-mock.cjs test-intake-flow.ts
 */

const Module = require('module');

// --- In-memory storage ---
const conversations = new Map(); // id -> row object
const projects = new Map();      // id -> row object
const messageDedup = new Set();   // message_ts strings
let nextConvoId = 1;
let nextProjectId = 1;

function now() { return new Date().toISOString(); }
function later24h() { return new Date(Date.now() + 86400000).toISOString(); }

// --- SQL pattern matching ---

function handleQuery(sql, params = []) {
  const trimmed = sql.replace(/\s+/g, ' ').trim();

  // CREATE TABLE — no-op
  if (trimmed.startsWith('CREATE TABLE')) {
    return { rows: [], rowCount: 0 };
  }

  // DELETE FROM message_dedup (cleanup) — no-op
  if (trimmed.includes('DELETE FROM message_dedup WHERE created_at')) {
    return { rows: [], rowCount: 0 };
  }

  // Stale conversation cleanup on startup — no-op
  if (trimmed.includes("UPDATE conversations SET status = 'cancelled'") && trimmed.includes('expires_at < NOW()')) {
    return { rows: [], rowCount: 0 };
  }

  // getConversation: SELECT * FROM conversations WHERE thread_ts = $1
  if (trimmed.includes('SELECT * FROM conversations WHERE thread_ts =') && !trimmed.includes('user_id')) {
    const threadTs = params[0];
    // Find active conversations in this thread, prioritizing active statuses
    const matches = [...conversations.values()]
      .filter(c => c.thread_ts === threadTs)
      .sort((a, b) => {
        const statusOrder = { gathering: 0, confirming: 0, pending_approval: 0, complete: 1, cancelled: 2, withdrawn: 2 };
        const sa = statusOrder[a.status] ?? 1;
        const sb = statusOrder[b.status] ?? 1;
        if (sa !== sb) return sa - sb;
        return new Date(b.updated_at) - new Date(a.updated_at);
      });
    return { rows: matches.slice(0, 1), rowCount: matches.length > 0 ? 1 : 0 };
  }

  // hasConversationInThread: SELECT 1 FROM conversations WHERE thread_ts = $1
  if (trimmed.includes('SELECT 1 FROM conversations WHERE thread_ts =')) {
    const threadTs = params[0];
    const exists = [...conversations.values()].some(c => c.thread_ts === threadTs);
    return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
  }

  // getConversationById: SELECT * FROM conversations WHERE id = $1
  if (trimmed.includes('SELECT * FROM conversations WHERE id =')) {
    const id = params[0];
    const row = conversations.get(id);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // upsertConversation INSERT
  if (trimmed.includes('INSERT INTO conversations') && trimmed.includes('RETURNING id')) {
    const id = nextConvoId++;
    const row = {
      id,
      user_id: params[0],
      user_name: params[1],
      channel_id: params[2],
      thread_ts: params[3],
      status: params[4],
      current_step: params[5],
      collected_data: typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6],
      classification: params[7],
      monday_item_id: params[8],
      triage_message_ts: null,
      triage_channel_id: null,
      timeout_notified: 0,
      created_at: now(),
      updated_at: now(),
      expires_at: later24h(),
    };
    conversations.set(id, row);
    return { rows: [{ id }], rowCount: 1 };
  }

  // upsertConversation UPDATE
  if (trimmed.includes('UPDATE conversations') && trimmed.includes('SET status =') && trimmed.includes('current_step =') && trimmed.includes('WHERE id =')) {
    const id = params[5];
    const row = conversations.get(id);
    if (row) {
      row.status = params[0];
      row.current_step = params[1];
      row.collected_data = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      row.classification = params[3];
      row.monday_item_id = params[4];
      row.updated_at = now();
      row.expires_at = later24h();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // cancelStaleConversationsForUser
  if (trimmed.includes("UPDATE conversations SET status = 'cancelled'") && trimmed.includes('user_id =') && trimmed.includes('thread_ts !=')) {
    const userId = params[0];
    const excludeThreadTs = params[1];
    let count = 0;
    for (const row of conversations.values()) {
      if (row.user_id === userId && ['gathering', 'confirming'].includes(row.status) && row.thread_ts !== excludeThreadTs) {
        row.status = 'cancelled';
        row.updated_at = now();
        count++;
      }
    }
    return { rows: [], rowCount: count };
  }

  // getActiveConversationForUser
  if (trimmed.includes('SELECT * FROM conversations WHERE user_id =') && trimmed.includes('thread_ts !=')) {
    const userId = params[0];
    const excludeThreadTs = params[1];
    const matches = [...conversations.values()]
      .filter(c => c.user_id === userId && ['gathering', 'confirming', 'pending_approval'].includes(c.status) && c.thread_ts !== excludeThreadTs)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return { rows: matches.slice(0, 1), rowCount: matches.length > 0 ? 1 : 0 };
  }

  // isMessageProcessed: INSERT INTO message_dedup ON CONFLICT
  if (trimmed.includes('INSERT INTO message_dedup')) {
    const messageTs = params[0];
    if (messageDedup.has(messageTs)) {
      return { rows: [], rowCount: 0 }; // Already processed
    }
    messageDedup.add(messageTs);
    return { rows: [{ message_ts: messageTs }], rowCount: 1 }; // Newly claimed
  }

  // updateMondayItemId
  if (trimmed.includes('UPDATE conversations SET monday_item_id')) {
    const itemId = params[0];
    const id = params[1];
    const row = conversations.get(id);
    if (row) {
      row.monday_item_id = itemId;
      row.updated_at = now();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // updateTriageInfo
  if (trimmed.includes('UPDATE conversations SET triage_message_ts')) {
    const messageTs = params[0];
    const channelId = params[1];
    const id = params[2];
    const row = conversations.get(id);
    if (row) {
      row.triage_message_ts = messageTs;
      row.triage_channel_id = channelId;
      row.updated_at = now();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // cancelConversation
  if (trimmed.includes("UPDATE conversations SET status = 'cancelled', updated_at = NOW() WHERE id =")) {
    const id = params[0];
    const row = conversations.get(id);
    if (row) {
      row.status = 'cancelled';
      row.updated_at = now();
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // createProject: INSERT INTO projects
  if (trimmed.includes('INSERT INTO projects')) {
    const id = nextProjectId++;
    const row = {
      id,
      name: params[0],
      type: params[1],
      requester_name: params[2],
      requester_slack_id: params[3],
      requester_email: params[4],
      division: params[5],
      status: params[6],
      drive_folder_url: params[7],
      brief_doc_url: params[8],
      monday_item_id: params[9],
      monday_url: params[10],
      source: params[11],
      due_date: params[12],
      created_at: now(),
    };
    projects.set(id, row);
    return { rows: [{ id }], rowCount: 1 };
  }

  // getProject
  if (trimmed.includes('SELECT * FROM projects WHERE id =')) {
    const id = params[0];
    const row = projects.get(id);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // searchProjects
  if (trimmed.includes('SELECT * FROM projects WHERE name ILIKE')) {
    const pattern = params[0].replace(/%/g, '').toLowerCase();
    const matches = [...projects.values()].filter(p => p.name.toLowerCase().includes(pattern));
    return { rows: matches.slice(0, 20), rowCount: matches.length };
  }

  // Generic SELECT returning empty
  if (trimmed.startsWith('SELECT')) {
    return { rows: [], rowCount: 0 };
  }

  // Generic UPDATE/DELETE returning 0
  if (trimmed.startsWith('UPDATE') || trimmed.startsWith('DELETE')) {
    return { rows: [], rowCount: 0 };
  }

  // Fallback
  console.warn(`[mock-pg] Unhandled query: ${trimmed.substring(0, 120)}`);
  return { rows: [], rowCount: 0 };
}

// --- Mock Pool class ---

class MockPool {
  constructor(_config) {
    // Ignore connection config
  }

  async query(sql, params) {
    // Handle template literal queries (from initDb which uses backticks with multiple statements)
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    let lastResult = { rows: [], rowCount: 0 };
    for (const stmt of statements) {
      lastResult = handleQuery(stmt, params);
    }
    return lastResult;
  }

  async end() {}
  async connect() { return { query: this.query.bind(this), release: () => {} }; }

  on(_event, _handler) { return this; }
}

// Expose reset for test cleanup
MockPool._reset = function() {
  conversations.clear();
  projects.clear();
  messageDedup.clear();
  nextConvoId = 1;
  nextProjectId = 1;
};

MockPool._conversations = conversations;
MockPool._messageDedup = messageDedup;

// --- Patch require('pg') ---

const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'pg') {
    return { Pool: MockPool, Client: MockPool };
  }
  return originalRequire.apply(this, arguments);
};

// Also set a global so the test can access reset
global.__mockPgPool = MockPool;
