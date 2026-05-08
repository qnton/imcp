#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  getMessageById,
  getMessageByMessageId,
  listFolders,
  mailStats,
  openMailDatabase,
  searchMessages,
} from "./db/mail-db.js";
import { keywordsToSearchTerms } from "./fts-query.js";
import { listRemoteMailboxes, syncMailboxes } from "./sync/imap-sync.js";

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

async function main() {
  const cfg = loadConfig();
  const store = await openMailDatabase(cfg.MAIL_DATABASE_PATH);
  const { db, flush } = store;

  const flushSync = (): void => {
    try {
      flush();
    } catch {
      /* ignore disk errors in MCP */
    }
  };

  process.on("beforeExit", flushSync);
  if (cfg.MAIL_SYNC_ON_START) {
    try {
      await syncMailboxes(cfg, store, { flush });
    } catch {
      /* ignore; tools can retry */
    }
  }

  const mcp = new McpServer(
    { name: "imap-email-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    "mail_sync",
    {
      description:
        "Read-only IMAP sync into local SQLite cache (EXAMINE/FETCH only). Fetch new messages since last UID per folder.",
      inputSchema: {
        mailboxes: z
          .array(z.string())
          .optional()
          .describe("Optional folder paths to sync; default all (or MAILBOXES env allowlist)"),
        maxMessagesPerFolder: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Cap messages imported per folder this run (0 or omit = no cap)"),
      },
    },
    async (args) => {
      const res = await syncMailboxes(cfg, store, {
        mailboxes: args.mailboxes,
        maxMessagesPerFolder: args.maxMessagesPerFolder,
        flush,
      });
      return jsonText(res);
    },
  );

  mcp.registerTool(
    "mail_search",
    {
      description:
        "Full-text search over cached subject/body/address fields using SQLite FTS5. Default: tokenized AND with broader fallback. raw_query broadens matching.",
      inputSchema: {
        query: z.string().min(1).describe("Search text; when raw_query=true, passed through as-is"),
        mailbox: z.string().optional().describe("Filter by IMAP folder path"),
        date_after: z.number().int().optional().describe("Unix seconds inclusive lower bound"),
        date_before: z.number().int().optional().describe("Unix seconds inclusive upper bound"),
        limit: z.number().int().positive().max(200).optional(),
        raw_query: z.boolean().optional().describe("If true, use broader OR-style matching"),
      },
    },
    async (args) => {
      const match = args.raw_query ? args.query : keywordsToSearchTerms(args.query);
      try {
        const hits = searchMessages(store, match, {
          mailbox: args.mailbox,
          date_after: args.date_after,
          date_before: args.date_before,
          limit: args.limit,
          combineWith: args.raw_query ? "OR" : "AND",
        });
        const slim = hits.map((h) => ({
          id: h.id,
          folder_path: h.folder_path,
          uid: h.uid,
          date: h.date,
          subject: h.subject,
          from_addr: h.from_addr,
          snippet: h.snippet,
          rank: h.rank,
        }));
        return jsonText({ match_used: match, count: slim.length, results: slim });
      } catch (e) {
        return jsonText({
          error: e instanceof Error ? e.message : String(e),
          hint: "Try fewer words or raw_query for broader OR matching",
        });
      }
    },
  );

  mcp.registerTool(
    "mail_get",
    {
      description: "Fetch one cached message by SQLite id or RFC Message-ID.",
      inputSchema: {
        id: z.number().int().positive().optional(),
        message_id: z.string().optional(),
      },
    },
    async (args) => {
      if (!args.id && !args.message_id) {
        return jsonText({ error: "Provide id or message_id" });
      }
      let row = args.id != null ? getMessageById(db, args.id) : undefined;
      if (!row && args.message_id) {
        const mid = args.message_id.trim().replace(/^<|>$/g, "");
        row = getMessageByMessageId(db, mid.includes("@") ? mid : args.message_id.trim());
      }
      if (!row) return jsonText({ error: "Not found in cache (run mail_sync)" });
      return jsonText(row);
    },
  );

  mcp.registerTool(
    "mail_list_mailboxes",
    {
      description:
        "List mailbox paths from the server (read-only LIST). Does not update the SQLite cache.",
      inputSchema: {
        cached: z
          .boolean()
          .optional()
          .describe("If true, list folders known in local cache instead of hitting IMAP"),
      },
    },
    async (args) => {
      if (args.cached) {
        const folders = listFolders(db);
        return jsonText({
          source: "cache",
          paths: folders.map((f) => f.path),
          details: folders,
        });
      }
      const { paths, error } = await listRemoteMailboxes(cfg);
      return jsonText({ source: "imap", paths, error });
    },
  );

  mcp.registerTool(
    "mail_stats",
    {
      description: "Row counts in local mail cache.",
    },
    async () => {
      const s = mailStats(db);
      return jsonText({ ...s, db_path: cfg.MAIL_DATABASE_PATH });
    },
  );

  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
