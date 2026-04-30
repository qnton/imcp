import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";

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
`;

/** Repo root (`imcp/`): `dist/db` -> `../..` when compiled. */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

type SqlParam = string | number | null | undefined;

function bindParams(params: SqlParam[]): SqlValue[] {
  return params.map((p) => (p === undefined ? null : p) as SqlValue);
}

function stmtGet<T extends Record<string, unknown>>(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParam[],
): T | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(bindParams(params));
  if (!stmt.step()) {
    stmt.free();
    return undefined;
  }
  const row = stmt.getAsObject() as T;
  stmt.free();
  return row;
}

function stmtAll<T extends Record<string, unknown>>(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParam[],
): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(bindParams(params));
  const out: T[] = [];
  while (stmt.step()) {
    out.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return out;
}

function run(db: SqlJsDatabase, sql: string, params: SqlParam[]): void {
  db.run(sql, bindParams(params));
}

export type MailDb = SqlJsDatabase;

export type SearchDoc = {
  id: number;
  folder_id: number;
  folder_path: string;
  uid: number;
  date: number | null;
  subject: string;
  body_text: string;
  snippet: string | null;
  message_id: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  flags: string | null;
};

function createSearchIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    idField: "id",
    fields: ["subject", "body_text"],
    storeFields: [
      "folder_id",
      "folder_path",
      "uid",
      "date",
      "snippet",
      "message_id",
      "from_addr",
      "to_addrs",
      "cc_addrs",
      "flags",
    ],
  });
}

function rowToDoc(r: Record<string, unknown>): SearchDoc & { id: number } {
  return {
    id: Number(r.id),
    folder_id: Number(r.folder_id),
    folder_path: String(r.folder_path ?? ""),
    uid: Number(r.uid),
    date: r.date == null ? null : Number(r.date),
    subject: String(r.subject ?? ""),
    body_text: String(r.body_text ?? ""),
    snippet: r.snippet == null ? null : String(r.snippet),
    message_id: r.message_id == null ? null : String(r.message_id),
    from_addr: r.from_addr == null ? null : String(r.from_addr),
    to_addrs: r.to_addrs == null ? null : String(r.to_addrs),
    cc_addrs: r.cc_addrs == null ? null : String(r.cc_addrs),
    flags: r.flags == null ? null : String(r.flags),
  };
}

function rebuildSearchIndex(db: SqlJsDatabase, index: MiniSearch<SearchDoc>): void {
  index.removeAll();
  const rows = stmtAll<Record<string, unknown>>(
    db,
    `SELECT m.id, m.folder_id, m.uid, m.message_id, m.date, m.subject, m.from_addr,
            m.to_addrs, m.cc_addrs, m.flags, m.body_text, m.snippet, f.path AS folder_path
     FROM messages m
     JOIN folders f ON f.id = m.folder_id`,
    [],
  );
  for (const r of rows) {
    index.add(rowToDoc(r));
  }
}

export type MailStore = {
  db: SqlJsDatabase;
  flush: () => void;
  /** Full-text index (MiniSearch); sql.js build has no FTS5. */
  searchIndex: MiniSearch<SearchDoc>;
};

export async function openMailDatabase(dbPath: string): Promise<MailStore> {
  const root = packageRoot();
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(root, "node_modules", "sql.js", "dist", file),
  });

  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db =
    fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();

  db.exec(MIGRATION_SQL);

  const searchIndex = createSearchIndex();
  rebuildSearchIndex(db, searchIndex);

  const flush = (): void => {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  };

  return { db, flush, searchIndex };
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

export function getFolderByPath(db: SqlJsDatabase, mailboxPath: string): FolderRow | undefined {
  return stmtGet<FolderRow>(db, `SELECT id, path, uidvalidity, last_uid, last_sync_at FROM folders WHERE path = ?`, [
    mailboxPath,
  ]);
}

export function upsertFolder(
  db: SqlJsDatabase,
  mailboxPath: string,
  uidvalidity: number,
  last_uid: number,
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
    [mailboxPath, uidvalidity, last_uid, ts],
  );
  const row = getFolderByPath(db, mailboxPath);
  if (!row) throw new Error(`folder upsert failed: ${mailboxPath}`);
  return row;
}

export function setFolderValidityAndResetUid(
  store: MailStore,
  folderId: number,
  mailboxPath: string,
  uidvalidity: number,
): void {
  const ids = stmtAll<{ id: number }>(store.db, `SELECT id FROM messages WHERE folder_id = ?`, [folderId]);
  for (const { id } of ids) {
    if (store.searchIndex.has(id)) store.searchIndex.discard(id);
  }
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

  const got = stmtGet<{ id: number }>(
    store.db,
    `SELECT id FROM messages WHERE folder_id = ? AND uid = ?`,
    [folderId, uid],
  );
  if (!got) return;

  const doc: SearchDoc & { id: number } = {
    id: got.id,
    folder_id: folderId,
    folder_path: folderPath,
    uid,
    date: row.date,
    subject: row.subject ?? "",
    body_text: row.body_text,
    snippet: row.snippet,
    message_id: row.message_id,
    from_addr: row.from_addr,
    to_addrs: row.to_addrs,
    cc_addrs: row.cc_addrs,
    flags: row.flags,
  };
  if (store.searchIndex.has(got.id)) {
    store.searchIndex.replace(doc);
  } else {
    store.searchIndex.add(doc);
  }
}

export function listFolders(db: SqlJsDatabase): FolderRow[] {
  return stmtAll<FolderRow>(
    db,
    `SELECT id, path, uidvalidity, last_uid, last_sync_at FROM folders ORDER BY path`,
    [],
  );
}

export function getMessageById(
  db: SqlJsDatabase,
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
  db: SqlJsDatabase,
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

/** MiniSearch query; `raw` passes the string through as a single query (prefix/fuzzy still apply). */
export function searchMessages(
  store: MailStore,
  query: string,
  opts: { mailbox?: string; date_after?: number; date_before?: number; limit?: number; combineWith?: "AND" | "OR" },
): SearchHit[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  const raw = query.trim();
  if (!raw) return [];

  const results = store.searchIndex.search(raw, {
    combineWith: opts.combineWith ?? "AND",
    prefix: true,
    fuzzy: 0.2,
    filter: (r) => {
      if (opts.mailbox && r.folder_path !== opts.mailbox) return false;
      if (opts.date_after != null && (r.date == null || r.date < opts.date_after)) return false;
      if (opts.date_before != null && (r.date == null || r.date > opts.date_before)) return false;
      return true;
    },
  });

  const hits: SearchHit[] = [];
  for (const r of results.slice(0, limit)) {
    const id = r.id as number;
    const full = getMessageById(store.db, id);
    if (!full) continue;
    hits.push({ ...full, rank: r.score });
  }
  return hits;
}

export function mailStats(db: SqlJsDatabase): { folders: number; messages: number } {
  const fc = stmtGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM folders`, []);
  const mc = stmtGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM messages`, []);
  return { folders: Number(fc?.c ?? 0), messages: Number(mc?.c ?? 0) };
}
