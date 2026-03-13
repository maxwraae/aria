import Database from "better-sqlite3";
import { generateId, now } from "./utils.js";

// ── Types ──────────────────────────────────────────────────────────

export interface Objective {
  id: string;
  objective: string;
  description: string | null;
  parent: string | null;
  status: string;
  waiting_on: string | null;
  resolution_summary: string | null;
  important: number;
  urgent: number;
  model: string;
  cwd: string | null;
  fail_count: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface InboxMessage {
  id: string;
  objective_id: string;
  message: string;
  sender: string;
  type: string;
  turn_id: string | null;
  created_at: number;
}

export interface Turn {
  id: string;
  objective_id: string;
  turn_number: number;
  user_message: string | null;
  session_id: string | null;
  created_at: number;
}

// ── Prepared statement cache ───────────────────────────────────────

const stmtCache = new WeakMap<Database.Database, Record<string, Database.Statement>>();

function stmt(db: Database.Database, key: string, sql: string): Database.Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = {};
    stmtCache.set(db, cache);
  }
  if (!cache[key]) {
    cache[key] = db.prepare(sql);
  }
  return cache[key];
}

// ── Objectives ─────────────────────────────────────────────────────

export function createObjective(
  db: Database.Database,
  opts: {
    objective: string;
    description?: string;
    parent?: string;
    model?: string;
    cwd?: string;
  }
): Objective {
  const id = generateId();
  const ts = now();
  const description = opts.description ?? null;
  const parent = opts.parent ?? null;
  const model = opts.model ?? "sonnet";
  const cwd = opts.cwd ?? null;

  stmt(
    db,
    "insertObjective",
    `INSERT INTO objectives (id, objective, description, parent, status, model, cwd, fail_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, 0, ?, ?)`
  ).run(id, opts.objective, description, parent, model, cwd, ts, ts);

  stmt(
    db,
    "insertFts",
    `INSERT INTO objectives_fts (rowid, objective, waiting_on, description, resolution_summary)
     VALUES ((SELECT rowid FROM objectives WHERE id = ?), ?, ?, ?, ?)`
  ).run(id, opts.objective, null, description, null);

  return getObjective(db, id)!;
}

export function getObjective(db: Database.Database, id: string): Objective | undefined {
  return stmt(db, "getObjective", "SELECT * FROM objectives WHERE id = ?").get(id) as
    | Objective
    | undefined;
}

export function getChildren(db: Database.Database, parentId: string): Objective[] {
  return stmt(
    db,
    "getChildren",
    "SELECT * FROM objectives WHERE parent = ? ORDER BY updated_at DESC"
  ).all(parentId) as Objective[];
}

export function getAncestors(db: Database.Database, id: string): Objective[] {
  const ancestors: Objective[] = [];
  let current = getObjective(db, id);
  while (current && current.parent) {
    const parent = getObjective(db, current.parent);
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent;
  }
  return ancestors;
}

export function getSiblings(db: Database.Database, id: string): Objective[] {
  const obj = getObjective(db, id);
  if (!obj || !obj.parent) return [];
  return stmt(
    db,
    "getSiblings",
    "SELECT * FROM objectives WHERE parent = ? AND id != ? ORDER BY updated_at DESC"
  ).all(obj.parent, id) as Objective[];
}

export function updateStatus(db: Database.Database, id: string, status: string): void {
  const ts = now();
  if (status === "resolved") {
    stmt(
      db,
      "updateStatusResolved",
      "UPDATE objectives SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?"
    ).run(status, ts, ts, id);
  } else {
    stmt(
      db,
      "updateStatus",
      "UPDATE objectives SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, ts, id);
  }
}

export function setWaitingOn(db: Database.Database, id: string, reason: string): void {
  const ts = now();
  stmt(
    db,
    "setWaitingOn",
    "UPDATE objectives SET waiting_on = ?, updated_at = ? WHERE id = ?"
  ).run(reason, ts, id);

  // Update FTS
  stmt(
    db,
    "updateFtsWaitingOn",
    `UPDATE objectives_fts SET waiting_on = ?
     WHERE rowid = (SELECT rowid FROM objectives WHERE id = ?)`
  ).run(reason, id);
}

export function clearWaitingOn(db: Database.Database, id: string): void {
  const ts = now();
  stmt(
    db,
    "clearWaitingOn",
    "UPDATE objectives SET waiting_on = NULL, updated_at = ? WHERE id = ?"
  ).run(ts, id);

  // Update FTS
  stmt(
    db,
    "clearFtsWaitingOn",
    `UPDATE objectives_fts SET waiting_on = NULL
     WHERE rowid = (SELECT rowid FROM objectives WHERE id = ?)`
  ).run(id);
}

export function updateObjective(db: Database.Database, id: string, fields: { objective?: string; description?: string }): void {
  const ts = now();
  if (fields.objective !== undefined) {
    stmt(db, "updateObjectiveName", "UPDATE objectives SET objective = ?, updated_at = ? WHERE id = ?").run(fields.objective, ts, id);
    stmt(db, "updateFtsObjective", `UPDATE objectives_fts SET objective = ? WHERE rowid = (SELECT rowid FROM objectives WHERE id = ?)`).run(fields.objective, id);
  }
  if (fields.description !== undefined) {
    stmt(db, "updateObjectiveDesc", "UPDATE objectives SET description = ?, updated_at = ? WHERE id = ?").run(fields.description, ts, id);
    stmt(db, "updateFtsDescription", `UPDATE objectives_fts SET description = ? WHERE rowid = (SELECT rowid FROM objectives WHERE id = ?)`).run(fields.description, id);
  }
}

export function setResolutionSummary(db: Database.Database, id: string, summary: string): void {
  const ts = now();
  stmt(
    db,
    "setResolutionSummary",
    "UPDATE objectives SET resolution_summary = ?, updated_at = ? WHERE id = ?"
  ).run(summary, ts, id);

  // Update FTS
  stmt(
    db,
    "updateFtsResolutionSummary",
    `UPDATE objectives_fts SET resolution_summary = ?
     WHERE rowid = (SELECT rowid FROM objectives WHERE id = ?)`
  ).run(summary, id);
}

export function cascadeAbandon(db: Database.Database, parentId: string): void {
  const abandon = db.transaction(() => {
    const ts = now();
    const children = stmt(
      db,
      "getActiveChildren",
      "SELECT id FROM objectives WHERE parent = ? AND status IN ('idle', 'needs-input')"
    ).all(parentId) as { id: string }[];

    for (const child of children) {
      stmt(
        db,
        "abandonObjective",
        "UPDATE objectives SET status = 'abandoned', updated_at = ? WHERE id = ?"
      ).run(ts, child.id);
      // Recurse into this child's children
      cascadeAbandon(db, child.id);
    }
  });
  abandon();
}

export function incrementFailCount(db: Database.Database, id: string): number {
  const ts = now();
  stmt(
    db,
    "incrementFail",
    "UPDATE objectives SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?"
  ).run(ts, id);
  const row = stmt(db, "getFailCount", "SELECT fail_count FROM objectives WHERE id = ?").get(
    id
  ) as { fail_count: number } | undefined;
  return row?.fail_count ?? 0;
}

export function searchObjectives(db: Database.Database, query: string): Objective[] {
  return stmt(
    db,
    "searchFts",
    `SELECT o.* FROM objectives o
     JOIN objectives_fts fts ON fts.rowid = o.rowid
     WHERE objectives_fts MATCH ?
     ORDER BY rank`
  ).all(query) as Objective[];
}

export function getTree(db: Database.Database): Objective[] {
  return stmt(
    db,
    "getTree",
    `SELECT * FROM objectives
     WHERE status NOT IN ('resolved', 'abandoned')
     ORDER BY parent NULLS FIRST, updated_at DESC`
  ).all() as Objective[];
}

// ── Inbox ──────────────────────────────────────────────────────────

export function insertMessage(
  db: Database.Database,
  opts: {
    objective_id: string;
    message: string;
    sender: string;
    type?: string;
  }
): InboxMessage {
  const id = generateId();
  const ts = now();
  const type = opts.type ?? "message";

  stmt(
    db,
    "insertMessage",
    `INSERT INTO inbox (id, objective_id, message, sender, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, opts.objective_id, opts.message, opts.sender, type, ts);

  // Touch the objective's updated_at
  stmt(db, "touchObjective", "UPDATE objectives SET updated_at = ? WHERE id = ?").run(
    ts,
    opts.objective_id
  );

  return stmt(db, "getMessage", "SELECT * FROM inbox WHERE id = ?").get(id) as InboxMessage;
}

export function getUnprocessedMessages(
  db: Database.Database,
  objectiveId: string
): InboxMessage[] {
  return stmt(
    db,
    "getUnprocessed",
    "SELECT * FROM inbox WHERE objective_id = ? AND turn_id IS NULL ORDER BY created_at"
  ).all(objectiveId) as InboxMessage[];
}

export function getConversation(
  db: Database.Database,
  objectiveId: string,
  limit: number = 50
): InboxMessage[] {
  return stmt(
    db,
    "getConversation",
    "SELECT * FROM inbox WHERE objective_id = ? ORDER BY created_at LIMIT ?"
  ).all(objectiveId, limit) as InboxMessage[];
}

export function stampMessages(
  db: Database.Database,
  objectiveId: string,
  turnId: string
): void {
  stmt(
    db,
    "stampMessages",
    "UPDATE inbox SET turn_id = ? WHERE objective_id = ? AND turn_id IS NULL"
  ).run(turnId, objectiveId);
}

export function getPendingObjectives(db: Database.Database): Objective[] {
  return stmt(
    db,
    "getPending",
    `SELECT DISTINCT o.* FROM objectives o
     JOIN inbox i ON i.objective_id = o.id
     WHERE i.turn_id IS NULL
       AND o.status IN ('idle', 'needs-input')
     ORDER BY o.urgent DESC, o.important DESC, o.created_at ASC`
  ).all() as Objective[];
}

// ── Turns ──────────────────────────────────────────────────────────

export function createTurn(
  db: Database.Database,
  opts: { objective_id: string }
): Turn {
  const id = generateId();
  const ts = now();

  const maxTurn = stmt(
    db,
    "maxTurnNumber",
    "SELECT COALESCE(MAX(turn_number), 0) as max_turn FROM turns WHERE objective_id = ?"
  ).get(opts.objective_id) as { max_turn: number };

  const turnNumber = maxTurn.max_turn + 1;

  stmt(
    db,
    "insertTurn",
    `INSERT INTO turns (id, objective_id, turn_number, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, opts.objective_id, turnNumber, ts);

  return stmt(db, "getTurn", "SELECT * FROM turns WHERE id = ?").get(id) as Turn;
}

export function updateTurnSession(
  db: Database.Database,
  turnId: string,
  sessionId: string
): void {
  stmt(
    db,
    "updateTurnSession",
    "UPDATE turns SET session_id = ? WHERE id = ?"
  ).run(sessionId, turnId);
}

// ── Engine helpers ─────────────────────────────────────────────────

export function getThinkingCount(db: Database.Database): number {
  const row = stmt(
    db,
    "thinkingCount",
    "SELECT COUNT(*) as count FROM objectives WHERE status = 'thinking'"
  ).get() as { count: number };
  return row.count;
}

export function getLastMaxMessageTime(db: Database.Database): number | null {
  const row = stmt(
    db,
    "lastMaxMsg",
    "SELECT MAX(created_at) as latest FROM inbox WHERE sender = 'max'"
  ).get() as { latest: number | null };
  return row.latest;
}

export type SenderRelation = 'max' | 'parent' | 'child' | 'sibling' | 'other' | 'system';

export interface SenderTag {
  relation: SenderRelation;
  label: string;
}

export function getSenderRelation(
  db: Database.Database,
  senderId: string,
  objectiveId: string
): SenderTag {
  if (senderId === 'max') return { relation: 'max', label: 'max' };
  if (senderId === 'system') return { relation: 'system', label: 'system' };

  const sender = getObjective(db, senderId);
  if (!sender) return { relation: 'other', label: senderId };

  const current = getObjective(db, objectiveId);
  if (!current) return { relation: 'other', label: senderId };

  const shortId = senderId.slice(0, 7);
  let relation: SenderRelation;

  if (senderId === current.parent) {
    relation = 'parent';
  } else if (sender.parent === objectiveId) {
    relation = 'child';
  } else if (sender.parent === current.parent && sender.parent !== null) {
    relation = 'sibling';
  } else {
    relation = 'other';
  }

  return { relation, label: `${relation}:${shortId} "${sender.objective}"` };
}

export interface SimilarResolved {
  id: string;
  objective: string;
  resolution_summary: string | null;
  rank: number;
}

export function findSimilarResolved(
  db: Database.Database,
  queryText: string,
  limit: number = 3
): SimilarResolved[] {
  // Tokenize: keep alphanumeric words, join with OR for broad FTS matching
  const tokens = queryText
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (tokens.length === 0) return [];

  const ftsQuery = tokens.join(" OR ");

  return stmt(
    db,
    "findSimilarResolved",
    `SELECT o.id, o.objective, o.resolution_summary, fts.rank
     FROM objectives o
     JOIN objectives_fts fts ON fts.rowid = o.rowid
     WHERE objectives_fts MATCH ?
       AND o.status = 'resolved'
     ORDER BY fts.rank
     LIMIT ?`
  ).all(ftsQuery, limit) as SimilarResolved[];
}

export function getStuckObjectives(
  db: Database.Database,
  thresholdSeconds: number
): Objective[] {
  const cutoff = now() - thresholdSeconds;
  return stmt(
    db,
    "stuck",
    "SELECT * FROM objectives WHERE status = 'thinking' AND updated_at < ?"
  ).all(cutoff) as Objective[];
}
