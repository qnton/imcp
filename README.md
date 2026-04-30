## imcp

Read-only IMAP MCP: mirrors mail into **SQLite (sql.js / WASM)** with an in-memory **MiniSearch** index (SQLite build in sql.js has no FTS5), exposes `**mail_sync`**, `**mail_search**`, `**mail_get**`, `**mail_list_mailboxes**`, `**mail_stats**`. Uses `**EXAMINE` + UID `FETCH**` only (see `mailboxOpen(..., { readOnly: true })`); never `STORE`, `APPEND`, `MOVE`, etc.

### Requirements

- **Node.js** 20 or newer
- Disk space for the local SQLite cache (default `./data/mail.sqlite`)
- IMAP credentials via environment variables (use app passwords where your provider requires them). Do not commit `.env`.

### Install

**From npm** (after publish):

```bash
npm install -g imap-email-mcp
```

**From source**:

```bash
git clone <repo-url> imcp && cd imcp && npm ci && npm run build
```

Create `.env` (see [.env.example](.env.example)). Then point your MCP client at the server.

### MCP client config

Using the global `**imap-email-mcp**` binary (on your `PATH` after `npm install -g`):

```json
{
  "mcpServers": {
    "imap-email": {
      "command": "imap-email-mcp",
      "cwd": "/ABS/PATH/TO/PACKAGE_OR_CLONE",
      "env": {}
    }
  }
}
```

Using `**node**` and the built file (typical for a local clone):

```json
{
  "mcpServers": {
    "imap-email": {
      "command": "node",
      "args": ["/ABS/PATH/imcp/dist/index.js"],
      "cwd": "/ABS/PATH/imcp",
      "env": {}
    }
  }
}
```

If you prefer `.env`, either load via `envFile` support in your client or duplicate variables under `env` (Cursor often uses `env` only).

Recommended: keep secrets out of version control; inject `IMAP_*` via your client `env`.

### Maintainer checks (local)

After `npm run build`:

- `npm run test:mcp` — smoke test with stub IMAP (no real mailbox).
- `npm run test:mcp:live` — uses your configured env and real IMAP (optional).

### Workflow

1. `**mail_sync**` — pull new UIDs since last run per folder (`UIDVALIDITY` change clears that folder cache).
2. `**mail_search**` — MiniSearch over cached `subject` + `body_text`. Default splits into words with AND; `**raw_query: true**` uses your string as-is and OR-combines terms.
3. `**mail_get**` — full row from SQLite by `id` or `message_id`.

### Limits

First large sync over IMAP may take time. Use `**MAIL_SYNC_ON_START**` only if startup delay is acceptable, or `**maxMessagesPerFolder**` on `mail_sync` to pace imports.

