import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { gmailMessageSchema, gmailPartSchema, type GmailPart } from "@winston/contracts/gmail";
import type { ResolvedTarget } from "@winston/contracts/connection-targets";

export function decodeGmailBody(data: string, expectedSize: number) {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw new Error("Invalid Gmail body encoding.");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.length !== expectedSize || bytes.toString("base64url") !== data.replace(/=+$/, ""))
    throw new Error("Invalid Gmail body size or encoding.");
  return bytes;
}

export function gmailParts(payload: unknown) {
  const pending = [{ value: payload, depth: 0 }];
  const result: GmailPart[] = [];
  const ids = new Set<string>();
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    if (entry.depth > 32 || result.length >= 1000)
      throw new Error("Gmail MIME structure exceeds limits.");
    const part = gmailPartSchema.parse(entry.value);
    if (ids.has(part.partId)) throw new Error("Duplicate Gmail MIME part identifier.");
    ids.add(part.partId);
    result.push(part);
    for (const child of [...part.parts].reverse())
      pending.push({ value: child, depth: entry.depth + 1 });
  }
  return result;
}

export function attachmentMetadata(source: ResolvedTarget, messageId: string, part: GmailPart) {
  return {
    // Filenames are display metadata, never paths or attachment identities.
    reference: createHash("sha256")
      .update(JSON.stringify([source.connectionId, messageId, part.partId]))
      .digest("hex"),
    connectionId: source.connectionId,
    messageId,
    partId: part.partId,
    filename: part.filename || "attachment",
    mimeType: part.mimeType,
    size: part.body.size,
  };
}

export function readGmailMessage(input: unknown, source: ResolvedTarget) {
  const message = gmailMessageSchema.parse(input);
  const parts = gmailParts(message.payload);
  const text: { partId: string; mimeType: string; text: string; truncated: boolean }[] = [];
  const attachments: ReturnType<typeof attachmentMetadata>[] = [];
  let remaining = 64_000;
  for (const part of parts) {
    if (part.parts.length) continue;
    if (
      part.filename ||
      part.body.attachmentId ||
      !["text/plain", "text/html"].includes(part.mimeType)
    ) {
      attachments.push(attachmentMetadata(source, message.id, part));
      continue;
    }
    const contentType =
      part.headers.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
    const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
    let decoded: string;
    try {
      decoded = new TextDecoder(charset, { fatal: true }).decode(
        decodeGmailBody(part.body.data ?? "", part.body.size),
      );
    } catch {
      // Preserve undecodable bytes as a retrievable part instead of silently corrupting text.
      attachments.push(attachmentMetadata(source, message.id, part));
      continue;
    }
    const excerpt = decoded.slice(0, remaining);
    remaining -= excerpt.length;
    text.push({
      partId: part.partId,
      mimeType: part.mimeType,
      text: excerpt,
      truncated: excerpt.length < decoded.length,
    });
  }
  return {
    source,
    trust: "untrusted_external_content" as const,
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    internalDate: message.internalDate ?? null,
    headers:
      parts[0]?.headers.filter((header) =>
        ["from", "to", "cc", "subject", "date", "message-id"].includes(header.name.toLowerCase()),
      ) ?? [],
    text,
    attachments,
  };
}
