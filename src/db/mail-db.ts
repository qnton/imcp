import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  uidvalidity INTEGER NOT NULL DEFAULT 0,
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  message_id TEXT,
  date INTEGER,
  subject TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  flags TEXT,
  body_text TEXT NOT NULL DEFAULT '',
  snippet TEXT,
  UNIQUE (folder_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_uid ON messages (folder_id, uid);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages (message_id);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (date);

CREATE TABLE IF NOT EXISTS imcp_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject,
  body_text,
  from_addr,
  to_addrs,
  cc_addrs,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body_text, from_addr, to_addrs, cc_addrs)
  VALUES (new.id, new.subject, new.body_text, new.from_addr, new.to_addrs, new.cc_addrs);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_addr, to_addrs, cc_addrs)
  VALUES('delete', old.id, old.subject, old.body_text, old.from_addr, old.to_addrs, old.cc_addrs);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, body_text, from_addr, to_addrs, cc_addrs)
  VALUES('delete', old.id, old.subject, old.body_text, old.from_addr, old.to_addrs, old.cc_addrs);
  INSERT INTO messages_fts(rowid, subject, body_text, from_addr, to_addrs, cc_addrs)
  VALUES (new.id, new.subject, new.body_text, new.from_addr, new.to_addrs, new.cc_addrs);
END;
`;

type SqlParam = string | number | null | undefined;

function bindParams(params: SqlParam[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

function stmtGet<T extends Record<string, unknown>>(
  db: BetterSqliteDatabase,
  sql: string,
  params: SqlParam[] = [],
): T | undefined {
  return db.prepare(sql).get(...bindParams(params)) as T | undefined;
}

function stmtAll<T extends Record<string, unknown>>(
  db: BetterSqliteDatabase,
  sql: string,
  params: SqlParam[] = [],
): T[] {
  return db.prepare(sql).all(...bindParams(params)) as T[];
}

function run(db: BetterSqliteDatabase, sql: string, params: SqlParam[] = []): void {
  db.prepare(sql).run(...bindParams(params));
}

function assertFts5(db: BetterSqliteDatabase): void {
  const row = stmtGet<{ ok: number }>(
    db,
    `SELECT sqlite_compileoption_used('ENABLE_FTS5') AS ok`,
  );
  if (Number(row?.ok ?? 0) !== 1) {
    throw new Error("SQLite FTS5 is not available in better-sqlite3 build");
  }
}

function rebuildFtsIfNeeded(db: BetterSqliteDatabase): void {
  const messageCount = Number(stmtGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM messages`)?.c ?? 0);
  const version = stmtGet<{ value: string }>(db, `SELECT value FROM imcp_meta WHERE key = 'fts_schema_version'`)?.value;
  if (version !== "1" && messageCount > 0) {
    db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`).run();
  }
  run(
    db,
    `INSERT INTO imcp_meta(key, value) VALUES('fts_schema_version', '1')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

export type MailDb = BetterSqliteDatabase;

export type MailStore = {
  db: BetterSqliteDatabase;
  flush: () => void;
};

export async function openMailDatabase(dbPath: string): Promise<MailStore> {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  assertFts5(db);
  db.exec(MIGRATION_SQL);
  rebuildFtsIfNeeded(db);

  return { db, flush: () => undefined };
}

export type FolderRow = {
  id: number;
  path: string;
  uidvalidity: number;
  last_uid: number;
  last_sync_at: number | null;
};

export type MessageRow = {
  id: number;
  folder_id: number;
  uid: number;
  message_id: string | null;
  date: number | null;
  subject: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  flags: string | null;
  body_text: string;
  snippet: string | null;
};

export function getFolderByPath(db: BetterSqliteDatabase, mailboxPath: string): FolderRow | undefined {
  return stmtGet<FolderRow>(db, `SELECT id, path, uidvalidity, last_uid, last_sync_at FROM folders WHERE path = ?`, [
    mailboxPath,
  ]);
}

export function upsertFolder(
  db: BetterSqliteDatabase,
  mailboxPath: string,
  uidvalidity: number,
  lastUid: number,
): FolderRow {
  const ts = Math.floor(Date.now() / 1000);
  run(
    db,
    `INSERT INTO folders (path, uidvalidity, last_uid, last_sync_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       uidvalidity = excluded.uidvalidity,
       last_uid = excluded.last_uid,
       last_sync_at = excluded.last_sync_at`,
    [mailboxPath, uidvalidity, lastUid, ts],
  );
  const row = getFolderByPath(db, mailboxPath);
  if (!row) throw new Error(`folder upsert failed: ${mailboxPath}`);
  return row;
}

export function beginWrite(db: BetterSqliteDatabase): void {
  db.prepare("BEGIN IMMEDIATE").run();
}

export function commitWrite(db: BetterSqliteDatabase): void {
  db.prepare("COMMIT").run();
}

export function rollbackWrite(db: BetterSqliteDatabase): void {
  if (db.inTransaction) db.prepare("ROLLBACK").run();
}

export function setFolderValidityAndResetUid(
  store: MailStore,
  folderId: number,
  mailboxPath: string,
  uidvalidity: number,
): void {
  run(store.db, `DELETE FROM messages WHERE folder_id = ?`, [folderId]);
  run(store.db, `UPDATE folders SET uidvalidity = ?, last_uid = 0, last_sync_at = ? WHERE id = ?`, [
    uidvalidity,
    Math.floor(Date.now() / 1000),
    folderId,
  ]);
  void mailboxPath;
}

export function insertMessage(
  store: MailStore,
  folderId: number,
  folderPath: string,
  uid: number,
  row: Omit<MessageRow, "id" | "folder_id" | "uid">,
): void {
  run(
    store.db,
    `INSERT INTO messages (
      folder_id, uid, message_id, date, subject, from_addr, to_addrs, cc_addrs,
      flags, body_text, snippet
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(folder_id, uid) DO UPDATE SET
      message_id = excluded.message_id,
      date = excluded.date,
      subject = excluded.subject,
      from_addr = excluded.from_addr,
      to_addrs = excluded.to_addrs,
      cc_addrs = excluded.cc_addrs,
      flags = excluded.flags,
      body_text = excluded.body_text,
      snippet = excluded.snippet`,
    [
      folderId,
      uid,
      row.message_id,
      row.date,
      row.subject,
      row.from_addr,
      row.to_addrs,
      row.cc_addrs,
      row.flags,
      row.body_text,
      row.snippet,
    ],
  );
  void folderPath;
}

export function updateMessageBody(
  db: BetterSqliteDatabase,
  id: number,
  bodyText: string,
  snippet: string | null,
): void {
  run(db, `UPDATE messages SET body_text = ?, snippet = ? WHERE id = ?`, [bodyText, snippet, id]);
}

export function listFolders(db: BetterSqliteDatabase): FolderRow[] {
  return stmtAll<FolderRow>(
    db,
    `SELECT id, path, uidvalidity, last_uid, last_sync_at FROM folders ORDER BY path`,
  );
}

export function getMessageById(
  db: BetterSqliteDatabase,
  id: number,
): (MessageRow & { folder_path: string }) | undefined {
  return stmtGet<MessageRow & { folder_path: string }>(
    db,
    `SELECT m.id, m.folder_id, m.uid, m.message_id, m.date, m.subject, m.from_addr,
            m.to_addrs, m.cc_addrs, m.flags, m.body_text, m.snippet, f.path AS folder_path
     FROM messages m
     JOIN folders f ON f.id = m.folder_id
     WHERE m.id = ?`,
    [id],
  );
}

export function getMessageByMessageId(
  db: BetterSqliteDatabase,
  messageId: string,
): (MessageRow & { folder_path: string }) | undefined {
  return stmtGet<MessageRow & { folder_path: string }>(
    db,
    `SELECT m.id, m.folder_id, m.uid, m.message_id, m.date, m.subject, m.from_addr,
            m.to_addrs, m.cc_addrs, m.flags, m.body_text, m.snippet, f.path AS folder_path
     FROM messages m
     JOIN folders f ON f.id = m.folder_id
     WHERE m.message_id = ?
     ORDER BY m.date DESC
     LIMIT 1`,
    [messageId.trim()],
  );
}

export type SearchHit = MessageRow & { folder_path: string; rank: number };

function ftsTokens(input: string): string[] {
  return input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function strictFtsQuery(input: string): string {
  return ftsTokens(input)
    .map((t) => `${quoteFtsToken(t)}*`)
    .join(" AND ");
}

function broadFtsQuery(input: string): string {
  return ftsTokens(input)
    .map((t) => `${quoteFtsToken(t)}*`)
    .join(" OR ");
}

function searchSql(extraWhere: string): string {
  return `
    SELECT m.id, m.folder_id, m.uid, m.message_id, m.date, m.subject, m.from_addr,
           m.to_addrs, m.cc_addrs, m.flags, m.body_text,
           COALESCE(NULLIF(snippet(messages_fts, 1, '', '', ' ... ', 24), ''), m.snippet) AS snippet,
           f.path AS folder_path,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN folders f ON f.id = m.folder_id
    WHERE messages_fts MATCH ?
      ${extraWhere}
    ORDER BY rank, m.date DESC, m.id DESC
    LIMIT ?`;
}

function searchOnce(
  db: BetterSqliteDatabase,
  match: string,
  opts: { mailbox?: string; date_after?: number; date_before?: number; limit: number; excludeIds?: Set<number> },
): SearchHit[] {
  const where: string[] = [];
  const params: SqlParam[] = [match];
  if (opts.mailbox) {
    where.push("AND f.path = ?");
    params.push(opts.mailbox);
  }
  if (opts.date_after != null) {
    where.push("AND m.date IS NOT NULL AND m.date >= ?");
    params.push(opts.date_after);
  }
  if (opts.date_before != null) {
    where.push("AND m.date IS NOT NULL AND m.date <= ?");
    params.push(opts.date_before);
  }
  params.push(opts.limit);

  const rows = stmtAll<SearchHit>(db, searchSql(where.join("\n")), params);
  if (!opts.excludeIds?.size) return rows;
  return rows.filter((r) => !opts.excludeIds?.has(r.id));
}

export function searchMessages(
  store: MailStore,
  query: string,
  opts: { mailbox?: string; date_after?: number; date_before?: number; limit?: number; combineWith?: "AND" | "OR" },
): SearchHit[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const raw = query.trim();
  if (!raw) return [];

  const firstMatch = opts.combineWith === "OR" ? broadFtsQuery(raw) : strictFtsQuery(raw);
  if (!firstMatch) return [];

  const hits = searchOnce(store.db, firstMatch, { ...opts, limit });
  if (hits.length >= limit || opts.combineWith === "OR") return hits.slice(0, limit);

  const seen = new Set(hits.map((h) => h.id));
  const fallbackMatch = broadFtsQuery(raw);
  if (!fallbackMatch || fallbackMatch === firstMatch) return hits;

  const fallback = searchOnce(store.db, fallbackMatch, {
    ...opts,
    limit: limit - hits.length,
    excludeIds: seen,
  });
  return [...hits, ...fallback].slice(0, limit);
}

export function mailStats(db: BetterSqliteDatabase): { folders: number; messages: number } {
  const fc = stmtGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM folders`);
  const mc = stmtGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM messages`);
  return { folders: Number(fc?.c ?? 0), messages: Number(mc?.c ?? 0) };
}
