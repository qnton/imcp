## imcp

Read-only IMAP MCP server with a local SQLite cache and FTS5 email search.

It exposes:

- `mail_sync` - sync new messages from IMAP into SQLite
- `mail_search` - search cached subject, body, and address fields
- `mail_get` - fetch a cached message by SQLite id or Message-ID
- `mail_get_full` - fetch the full message body from IMAP and update cache
- `mail_list_mailboxes` - list IMAP folders or cached folders
- `mail_stats` - show cache counts and database path

The server opens mailboxes read-only and syncs with IMAP `EXAMINE`/`FETCH`.

### Requirements

- Node.js 20+
- IMAP credentials
- Disk space for the SQLite cache, defaulting to `./data/mail.sqlite`

### Install

```bash
git clone https://github.com/qnton/imcp
cd imcp
npm ci
npm run build
```

Create `.env` from [.env.example](.env.example):

```env
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_USER=you@example.com
IMAP_PASSWORD=app-password
IMAP_SECURE=1
```

Optional settings include `MAIL_DATABASE_PATH`, `MAILBOXES`, `MAIL_SYNC_ON_START`, and
`MAIL_MAX_BODY_BYTES`.

### MCP Config

For a local clone:

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

Put secrets in your MCP client `env` or in `.env`. Do not commit credentials.

### Development

```bash
npm run build
npm run test:mcp
npm run test:db
```

`npm run test:mcp:live` uses your configured real IMAP account.
