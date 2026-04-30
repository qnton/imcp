declare module "mailparser" {
  export function simpleParser(
    source: Buffer | string | import("stream").Readable,
  ): Promise<{
    text?: string;
    html?: string;
    subject?: string;
    messageId?: string;
    date?: Date;
  }>;
}
