import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { text as streamText } from "node:stream/consumers";
import type { Config } from "../config.js";
import {
  beginWrite,
  commitWrite,
  getFolderByPath,
  insertMessage,
  type MailStore,
  rollbackWrite,
  setFolderValidityAndResetUid,
  upsertFolder,
} from "../db/mail-db.js";

function addrListToString(
  list: { name?: string; address?: string }[] | undefined,
): string | null {
  if (!list?.length) return null;
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : a.address ?? ""))
    .filter(Boolean)
    .join(", ");
}

function flagsToString(flags: Set<string> | undefined): string | null {
  if (!flags?.size) return null;
  return JSON.stringify([...flags].sort());
}

export function snippetFromText(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}...`;
}

function normMessageId(mid?: string | null): string | null {
  if (!mid) return null;
  const t = mid.trim().replace(/^<|>$/g, "").trim();
  return t.length ? t : null;
}

type TextPart = { part: string; contentType: "text/plain" | "text/html"; size: number };

function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition?.toLowerCase() === "attachment";
}

function bodyPartScore(part: TextPart): number {
  return (part.contentType === "text/plain" ? 0 : 10) + Math.min(part.size, 10_000_000) / 10_000_000;
}

function decodeQuotedPrintable(input: string): Buffer {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (
      normalized[i] === "=" &&
      i + 2 < normalized.length &&
      /^[0-9a-f]{2}$/i.test(normalized.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeText(buffer: Buffer, charset?: string): string {
  const normalized = charset?.trim().toLowerCase().replace(/^"|"$/g, "");
  if (normalized === "iso-8859-1" || normalized === "latin1" || normalized === "windows-1252") {
    return buffer.toString("latin1");
  }
  return buffer.toString("utf8");
}

export function textFromMessageSource(source: Buffer): string {
  const raw = source.toString("latin1");
  const split = raw.match(/\r?\n\r?\n/);
  if (!split?.index) return "";

  const headers = raw.slice(0, split.index);
  const unfoldedHeaders = headers.replace(/\r?\n[ \t]+/g, " ");
  const body = raw.slice(split.index + split[0].length);
  const contentType = unfoldedHeaders.match(/^content-type:\s*([^;\r\n]+)([^\r\n]*)/im);
  const type = contentType?.[1]?.trim().toLowerCase();
  if (type && type !== "text/plain") return "";

  const charset = contentType?.[2]?.match(/charset="?([^";\r\n]+)"?/i)?.[1];
  const encoding = unfoldedHeaders.match(/^content-transfer-encoding:\s*([^\r\n]+)/im)?.[1]?.trim().toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body.replace(/\s+/g, ""), "base64")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, "latin1");

  return decodeText(bytes, charset).trim();
}

export function selectTextBodyPart(structure?: MessageStructureObject): TextPart | undefined {
  if (!structure) return undefined;
  const parts: TextPart[] = [];
  const visit = (node: MessageStructureObject): void => {
    const type = node.type.toLowerCase();
    const part = node.part ?? (!node.childNodes?.length ? "1" : undefined);
    if (!isAttachment(node) && part && (type === "text/plain" || type === "text/html")) {
      parts.push({
        part,
        contentType: type,
        size: Number(node.size ?? 0),
      });
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(structure);
  return parts.sort((a, b) => bodyPartScore(a) - bodyPartScore(b))[0];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<tr\b[^>]*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, "  - ") // Use bullet to ensure indentation is preserved
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\n+/g, "\n\n")
    .trim();
}

async function downloadTextPart(
  client: ImapFlow,
  uid: number,
  part: TextPart,
  maxBytes?: number,
): Promise<string> {
  const downloaded = await client.download(String(uid), part.part, { uid: true, maxBytes });
  if (!downloaded.content) return "";
  const body = await streamText(downloaded.content);
  return part.contentType === "text/html" ? htmlToText(body) : body;
}

async function downloadTextFromSource(
  client: ImapFlow,
  uid: number,
  maxBytes?: number,
): Promise<string> {
  const msg = await client.fetchOne(
    String(uid),
    { source: maxBytes != null ? { start: 0, maxLength: maxBytes } : true },
    { uid: true },
  );
  const source = msg && "source" in msg ? msg.source : undefined;
  return source ? textFromMessageSource(source) : "";
}

export type SyncResult = {
  mailboxes: string[];
  folders_synced: number;
  messages_imported: number;
  errors: string[];
};

export function newestFetchedMessages(
  messages: FetchMessageObject[],
  maxMessages: number,
): FetchMessageObject[] {
  if (maxMessages <= 0 || messages.length <= maxMessages) return messages;
  return messages.slice(-maxMessages);
}

export async function syncMailboxes(
  cfg: Config,
  store: MailStore,
  options?: { mailboxes?: string[]; maxMessagesPerFolder?: number; flush?: () => void },
): Promise<SyncResult> {
  const errors: string[] = [];
  let messages_imported = 0;
  const db = store.db;
  const client = new ImapFlow({
    host: cfg.IMAP_HOST,
    port: cfg.IMAP_PORT,
    secure: cfg.IMAP_SECURE,
    auth: { user: cfg.IMAP_USER, pass: cfg.IMAP_PASSWORD },
    logger: false,
  });

  const allow =
    options?.mailboxes != null && options.mailboxes.length > 0
      ? new Set(options.mailboxes)
      : cfg.MAILBOXES?.length
        ? new Set(cfg.MAILBOXES)
        : null;

  let mailboxes: string[] = [];

  try {
    await client.connect();
    const listed = await client.list();
    mailboxes = listed
      .filter((e) => e.listed)
      .map((e) => e.path)
      .filter((path) => !allow || allow.has(path));

    const maxPer = options?.maxMessagesPerFolder ?? 0;

    for (const path of mailboxes) {
      try {
        const mbox = await client.mailboxOpen(path, { readOnly: true });
        const uidValidity = Number(mbox.uidValidity);
        if (!Number.isFinite(uidValidity)) {
          errors.push(`${path}: invalid UIDVALIDITY`);
          continue;
        }

        let folderRow = getFolderByPath(db, path);
        if (folderRow && folderRow.uidvalidity !== uidValidity) {
          setFolderValidityAndResetUid(store, folderRow.id, path, uidValidity);
          folderRow = getFolderByPath(db, path);
        }
        if (!folderRow) {
          upsertFolder(db, path, uidValidity, 0);
          folderRow = getFolderByPath(db, path);
        }
        if (!folderRow) {
          errors.push(`${path}: folder row missing after upsert`);
          continue;
        }

        const lastUid = folderRow.last_uid;
        let maxUid = lastUid;
        const fetchedCandidates: FetchMessageObject[] = [];

        const query = {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          bodyStructure: true,
          size: true,
        } as const;
        const fetchOpts = { uid: true } as const;

        const nextUid = Number(mbox.uidNext);
        const fetchRange: `${number}:*` | `${number}:${number}` =
          maxPer > 0 && Number.isFinite(nextUid)
            ? `${Math.max(lastUid + 1, Math.max(lastUid, nextUid - 1) - maxPer * 50 + 1)}:${Math.max(lastUid, nextUid - 1)}`
            : `${lastUid + 1}:*`;

        if (maxPer > 0 && Number.isFinite(nextUid) && nextUid <= lastUid + 1) {
          beginWrite(db);
          upsertFolder(db, path, uidValidity, maxUid);
          commitWrite(db);
          options?.flush?.();
          continue;
        }

        for await (const msg of client.fetch(fetchRange, query, fetchOpts)) {
          fetchedCandidates.push(msg);
        }
        const fetched = newestFetchedMessages(fetchedCandidates, maxPer);

        beginWrite(db);

        for (const msg of fetched) {
          let bodyText = "";
          let subject: string | null = msg.envelope?.subject ?? null;
          let messageId: string | null = normMessageId(msg.envelope?.messageId);
          let dateSec: number | null = null;

          const d = msg.envelope?.date ?? msg.internalDate;
          if (d) dateSec = Math.floor(new Date(d).getTime() / 1000);

          const textPart = selectTextBodyPart(msg.bodyStructure);
          if (textPart) {
            try {
              bodyText = await downloadTextPart(client, msg.uid, textPart, cfg.MAIL_MAX_BODY_BYTES);
            } catch {
              bodyText = "";
            }
          }

          if (!bodyText) {
            try {
              bodyText = await downloadTextFromSource(client, msg.uid, cfg.MAIL_MAX_BODY_BYTES);
            } catch {
              bodyText = "";
            }
          }

          if (!bodyText && msg.envelope) {
            bodyText = [
              msg.envelope.subject ?? "",
              addrListToString(msg.envelope.from) ?? "",
            ]
              .filter(Boolean)
              .join("\n");
          }

          insertMessage(store, folderRow.id, path, msg.uid, {
            message_id: normMessageId(messageId ?? msg.envelope?.messageId),
            date: dateSec,
            subject,
            from_addr: addrListToString(msg.envelope?.from),
            to_addrs: addrListToString(msg.envelope?.to),
            cc_addrs: addrListToString(msg.envelope?.cc),
            flags: flagsToString(msg.flags),
            body_text: bodyText,
            snippet: snippetFromText(bodyText || subject || ""),
          });

          maxUid = Math.max(maxUid, msg.uid);
          messages_imported++;
        }

        upsertFolder(db, path, uidValidity, maxUid);
        commitWrite(db);
        options?.flush?.();
      } catch (e) {
        rollbackWrite(db);
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${path}: ${msg}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`connection: ${msg}`);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  return {
    mailboxes,
    folders_synced: mailboxes.length,
    messages_imported,
    errors,
  };
}

export async function fetchFullMessage(
  cfg: Config,
  mailboxPath: string,
  uid: number,
): Promise<string> {
  const client = new ImapFlow({
    host: cfg.IMAP_HOST,
    port: cfg.IMAP_PORT,
    secure: cfg.IMAP_SECURE,
    auth: { user: cfg.IMAP_USER, pass: cfg.IMAP_PASSWORD },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen(mailboxPath, { readOnly: true });

    const msg = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
    if (!msg) throw new Error("Message not found on server");

    const textPart = selectTextBodyPart(msg.bodyStructure);
    let bodyText = "";

    if (textPart) {
      try {
        bodyText = await downloadTextPart(client, uid, textPart);
      } catch {
        bodyText = "";
      }
    }

    if (!bodyText) {
      try {
        bodyText = await downloadTextFromSource(client, uid);
      } catch {
        bodyText = "";
      }
    }

    return bodyText;
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

export async function listRemoteMailboxes(cfg: Config): Promise<{ paths: string[]; error?: string }> {
  const client = new ImapFlow({
    host: cfg.IMAP_HOST,
    port: cfg.IMAP_PORT,
    secure: cfg.IMAP_SECURE,
    auth: { user: cfg.IMAP_USER, pass: cfg.IMAP_PASSWORD },
    logger: false,
  });
  try {
    await client.connect();
    const listed = await client.list();
    const paths = listed.filter((e) => e.listed).map((e) => e.path);
    return { paths };
  } catch (e) {
    return { paths: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
