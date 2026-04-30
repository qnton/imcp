#!/usr/bin/env node
/**
 * Spawns dist/index.js, checks tools/list + mail_stats (+ mail_list_mailboxes sample).
 *
 * Uses an isolated MAIL_DATABASE_PATH so your real DB is untouched.
 *
 * `--offline-imap` — bogus IMAP (CI / no mailbox); expects mail_list_mailboxes JSON `error`.
 * Without it — inherits your shell env (.env loaded by server via cwd repo root).
 */
import { mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param patch {Record<string,string>} */
function coerceEnv(patch, scrubImapForOffline) {
  const out = { ...process.env };
  if (scrubImapForOffline) {
    for (const key of [...Object.keys(out)]) {
      if (key.startsWith("IMAP_") || key === "MAIL_DATABASE_PATH" || key === "MAILBOXES") {
        delete out[key];
      }
    }
  }
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  const rec = {};
  for (const [k, v] of Object.entries(out)) {
    if (v !== undefined) rec[k] = String(v);
  }
  return rec;
}

async function smoke(flags) {
  const offlineImap = flags.has("--offline-imap");
  const dbPath = join(repoRoot, "data", `.mcp-selftest-${Date.now()}.sqlite`);
  mkdirSync(dirname(dbPath), { recursive: true });
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const envPatch = {
    MAIL_DATABASE_PATH: dbPath,
    MAIL_SYNC_ON_START: "0",
  };

  if (offlineImap) {
    Object.assign(envPatch, {
      IMAP_HOST: "127.0.0.1",
      IMAP_PORT: "1993",
      IMAP_USER: "selftest",
      IMAP_PASSWORD: "selftest",
      IMAP_SECURE: "0",
    });
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: coerceEnv(envPatch, offlineImap),
    stderr: "pipe",
  });

  transport.stderr?.on?.("data", (c) => process.stderr.write(c));

  const client = new Client({ name: "mcp-selftest", version: "0.0.0" });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    const names = (listed.tools ?? []).map((t) => t.name).sort();
    const want = ["mail_get", "mail_list_mailboxes", "mail_search", "mail_stats", "mail_sync"];
    const missing = want.filter((n) => !names.includes(n));
    if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);

    const statsRes = await client.callTool({ name: "mail_stats", arguments: {} });
    const statsText =
      statsRes.content?.[0]?.type === "text"
        ? statsRes.content[0].text
        : JSON.stringify(statsRes.content);

    const statsParsed = JSON.parse(statsText);
    if (statsParsed.folders !== 0 || statsParsed.messages !== 0) {
      throw new Error(`expected empty cache, got ${statsText}`);
    }

    const listMb = await client.callTool({
      name: "mail_list_mailboxes",
      arguments: {},
    });
    const listText =
      listMb.content?.[0]?.type === "text" ? listMb.content[0].text : JSON.stringify(listMb);
    let listParsed;
    try {
      listParsed = JSON.parse(listText);
    } catch {
      throw new Error(`mail_list_mailboxes invalid JSON: ${listText.slice(0, 200)}`);
    }

    if (offlineImap) {
      if (!listParsed.error) throw new Error("offline-imap mode: expected IMAP connection error");
    }

    console.log("OK tools:", names.join(", "));
    console.log("OK mail_stats:", statsText.trim());
    console.log(`OK mail_list_mailboxes (${offlineImap ? "offline" : "live"}):`, listText.trim().slice(0, 200));
    console.log("-- selftest passed");
  } finally {
    await client.close();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
}

const flags = new Set(process.argv.slice(2));
smoke(flags).catch((err) => {
  console.error("SELFTEST FAIL:", err.message ?? err);
  process.exit(1);
});
