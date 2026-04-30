import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repo root (`imcp/`), regardless of MCP process `cwd` (Cursor sometimes uses another cwd). */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EnvSchema = z.object({
  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_USER: z.string().min(1),
  IMAP_PASSWORD: z.string().min(1),
  IMAP_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
  MAIL_DATABASE_PATH: z.string().optional(),
  MAILBOXES: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
    ),
  MAIL_SYNC_ON_START: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type Config = Omit<z.infer<typeof EnvSchema>, "MAIL_DATABASE_PATH" | "MAIL_SYNC_ON_START" | "IMAP_SECURE"> & {
  IMAP_SECURE: boolean;
  MAIL_DATABASE_PATH: string;
  MAIL_SYNC_ON_START: boolean;
};

export function loadConfig(): Config {
  dotenvConfig({ path: path.join(packageRoot, ".env") });
  dotenvConfig(); // cwd `.env` if present and keys still unset (dotenv skips existing vars)
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid env: ${JSON.stringify(msg)}`);
  }
  const secure = parsed.data.IMAP_SECURE !== false;
  return {
    ...parsed.data,
    IMAP_SECURE: secure,
    MAIL_DATABASE_PATH:
      parsed.data.MAIL_DATABASE_PATH ?? path.join(packageRoot, "data", "mail.sqlite"),
    MAIL_SYNC_ON_START: parsed.data.MAIL_SYNC_ON_START === true,
  };
}
