#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMessageById,
  insertMessage,
  mailStats,
  openMailDatabase,
  searchMessages,
  upsertFolder,
} from "../dist/db/mail-db.js";
import {
  htmlToText,
  newestFetchedMessages,
  selectTextBodyPart,
  textFromMessageSource,
} from "../dist/sync/imap-sync.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makePath(name) {
  const dir = join(tmpdir(), "imcp-selftest");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}-${Date.now()}-${process.pid}.sqlite`);
}

async function testSearch() {
  const dbPath = makePath("search");
  if (existsSync(dbPath)) rmSync(dbPath);
  const store = await openMailDatabase(dbPath);
  try {
    const inbox = upsertFolder(store.db, "INBOX", 1, 0);
    const archive = upsertFolder(store.db, "Archive", 1, 0);

    insertMessage(store, inbox.id, "INBOX", 1, {
      message_id: "one@example.test",
      date: 1_700_000_000,
      subject: "Quarterly launch notes",
      from_addr: "Product <product@example.test>",
      to_addrs: "Team <team@example.test>",
      cc_addrs: null,
      flags: null,
      body_text: "The account migration checklist is ready.",
      snippet: "The account migration checklist is ready.",
    });
    insertMessage(store, archive.id, "Archive", 2, {
      message_id: "two@example.test",
      date: 1_600_000_000,
      subject: "Migration archive",
      from_addr: "Archive <archive@example.test>",
      to_addrs: "Team <team@example.test>",
      cc_addrs: null,
      flags: null,
      body_text: "Old launch material.",
      snippet: "Old launch material.",
    });

    const strict = searchMessages(store, "quarterly migration", { limit: 10 });
    assert(strict[0]?.message_id === "one@example.test", "strict AND search should find body+subject hit");

    const fallback = searchMessages(store, "quarterly nonexistent", { limit: 10 });
    assert(fallback.some((hit) => hit.message_id === "one@example.test"), "broad fallback should recover partial hits");

    const filtered = searchMessages(store, "migration", {
      mailbox: "INBOX",
      date_after: 1_650_000_000,
      limit: 10,
    });
    assert(filtered.length === 1 && filtered[0].folder_path === "INBOX", "mailbox/date filters should apply in SQL");

    const full = getMessageById(store.db, strict[0].id);
    assert(full?.body_text.includes("checklist"), "message lookup should return stored body");

    const stats = mailStats(store.db);
    assert(stats.folders === 2 && stats.messages === 2, "stats should count inserted fixtures");
  } finally {
    store.db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
  }
}

async function testMigrationRebuild() {
  const dbPath = makePath("migration");
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      uidvalidity INTEGER NOT NULL DEFAULT 0,
      last_uid INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER
    );
    CREATE TABLE messages (
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
    INSERT INTO folders(path, uidvalidity, last_uid) VALUES ('INBOX', 1, 1);
    INSERT INTO messages(folder_id, uid, message_id, date, subject, body_text, snippet)
    VALUES (1, 1, 'legacy@example.test', 1700000000, 'Legacy searchable subject', 'legacy body', 'legacy body');
  `);
  db.close();

  const store = await openMailDatabase(dbPath);
  try {
    const hits = searchMessages(store, "legacy searchable", { limit: 5 });
    assert(hits.length === 1 && hits[0].message_id === "legacy@example.test", "migration should rebuild FTS");
  } finally {
    store.db.close();
    if (existsSync(dbPath)) rmSync(dbPath);
  }
}

function testSyncHelpers() {
  const selected = selectTextBodyPart({
    type: "multipart/alternative",
    childNodes: [
      { part: "1", type: "text/html", size: 100 },
      { part: "2", type: "text/plain", size: 1000 },
    ],
  });
  assert(selected?.part === "2", "plain text body part should be preferred");
  assert(htmlToText("<style>x</style><p>Hello&nbsp;<b>team</b></p>") === "Hello team", "HTML fallback should strip markup");

  const newest = newestFetchedMessages([{ uid: 1 }, { uid: 2 }, { uid: 3 }, { uid: 4 }], 2);
  assert(
    newest.length === 2 && newest[0].uid === 3 && newest[1].uid === 4,
    "bounded sync should keep newest fetched messages",
  );

  const source = Buffer.from(
    [
      "Subject: payment",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Gerne best\xe4tigen wir 1.214,00 EUR",
    ].join("\r\n"),
    "latin1",
  );
  assert(
    textFromMessageSource(source).includes("bestätigen wir 1.214,00 EUR"),
    "source fallback should decode simple latin1 text bodies",
  );
}

await testSearch();
await testMigrationRebuild();
testSyncHelpers();
console.log("-- db selftest passed");
