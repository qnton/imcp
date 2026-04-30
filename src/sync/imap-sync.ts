import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Config } from "../config.js";
import {
  getFolderByPath,
  insertMessage,
  type MailStore,
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

function snippetFromText(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function normMessageId(mid?: string | null): string | null {
  if (!mid) return null;
  const t = mid.trim().replace(/^<|>$/g, "").trim();
  return t.length ? t : null;
}

export type SyncResult = {
  mailboxes: string[];
  folders_synced: number;
  messages_imported: number;
  errors: string[];
};

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
        let folderCount = 0;

        const query = {
          uid: true,
          envelope: true,
          source: true,
          internalDate: true,
          flags: true,
        } as const;
        const fetchOpts = { uid: true } as const;

        for await (const msg of client.fetch(`${lastUid + 1}:*`, query, fetchOpts)) {
          if (!msg.source) continue;
          let bodyText = "";
          let subject: string | null = msg.envelope?.subject ?? null;
          let messageId: string | null = normMessageId(msg.envelope?.messageId);
          let dateSec: number | null = null;

          try {
            const parsed = await simpleParser(msg.source);
            bodyText = parsed.text || "";
            if (!subject && parsed.subject) subject = parsed.subject;
            if (!messageId && parsed.messageId) messageId = normMessageId(parsed.messageId);
            const d = parsed.date ?? msg.envelope?.date ?? msg.internalDate;
            if (d) dateSec = Math.floor(new Date(d).getTime() / 1000);
          } catch {
            bodyText = "";
            const d = msg.envelope?.date ?? msg.internalDate;
            if (d) dateSec = Math.floor(new Date(d).getTime() / 1000);
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
          folderCount++;
          messages_imported++;
          if (maxPer > 0 && folderCount >= maxPer) break;
        }

        upsertFolder(db, path, uidValidity, maxUid);
        options?.flush?.();
      } catch (e) {
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
