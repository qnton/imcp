## imcp

Read-only IMAP MCP: mirrors mail into **SQLite** with **FTS5** search, exposes `**mail_sync`**, `**mail_search`**, `**mail_get**`, `**mail_list_mailboxes**`, `**mail_stats**`. Uses `**EXAMINE` + UID `FETCH**` only (see `mailboxOpen(..., { readOnly: true })`); never `STORE`, `APPEND`, `MOVE`, etc.

### Requirements

- **Node.js** 20 or newer
- Disk space for the local SQLite cache (default `./data/mail.sqlite`)
- IMAP credentials via environment variables (use app passwords where your provider requires them). Do not commit `.env`.

### Install

```bash
git clone https://github.com/qnton/imcp && cd imcp && npm ci && npm run build
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
2. `**mail_search**` — SQLite FTS5 over cached `subject`, `body_text`, and address fields. Default splits into words with AND, then fills remaining results with a broader OR/prefix fallback; `**raw_query: true**` uses the broader path directly.
3. `**mail_get**` — full row from SQLite by `id` or `message_id`.

### Limits

First large sync over IMAP may take time. Sync fetches metadata first and downloads the best text body part instead of the full raw message when possible. Use `**MAIL_SYNC_ON_START**` only if startup delay is acceptable, `**maxMessagesPerFolder**` on `mail_sync` to pace imports, and `**MAIL_MAX_BODY_BYTES**` to cap indexed body text per message (default `262144`).

### Maintainer search checks

After `npm run build`:

- `npm run test:db` — fixture checks for SQLite FTS migration/search and body-part selection.
