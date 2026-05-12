# Gemini CLI Guidance for imcp

This repo provides a Model Context Protocol (MCP) server for read-only IMAP access.

## Tool Usage Workflows

### Reading Emails
- **`mail_get`**: Use this first to retrieve a message. It is fast because it reads from the local SQLite cache.
- **`mail_get_full`**: Use this if the body returned by `mail_get` appears truncated (e.g., ends with `...`), is empty, or if you are processing a complex structural document like a **receipt, invoice, or order confirmation** where the full HTML-to-text conversion is required. This tool performs a network request to IMAP.

### Searching and Syncing
- **`mail_sync`**: If you can't find a recent email, run this to pull new messages from the server into the cache.
- **`mail_search`**: Use this for full-text search. It uses SQLite FTS5. If a search is too narrow, try setting `raw_query: true`.

## Data Handling
- The local cache is stored in SQLite (default: `./data/mail.sqlite`).
- HTML bodies are converted to structured plain text to preserve readable layouts for tables and lists.
