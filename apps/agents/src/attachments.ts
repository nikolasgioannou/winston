/**
 * Files the user sends in Telegram land on their computer (docs/design.md
 * §4, Media). The webhook stores the message as a `pending` item; the
 * `save_attachment` job downloads the file, saves it under
 * `~/inbox/<date>/`, prepares a copy for the model where it can read the
 * file directly (images, short PDFs, small text files), records it in
 * `files`, and only then releases the item and queues the turn.
 */
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { files, inboundItems, users } from "@winston/db/schema";
import {
  userMessagePayloadSchema,
  type Attachment,
  type UserMessagePayload,
} from "@winston/domain/inbound";
import { frontTurnJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { formatInTimeZone } from "@winston/shared/time";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "./blobs.ts";
import { maxDownloadBytes, type TelegramFiles } from "./telegram/files.ts";
import { showImage } from "./tools/view-image.ts";
import type { VmClient } from "./vm/gateway-client.ts";
import type { JobHandler } from "./worker.ts";

/**
 * Limits on what's shown to the model with the message. A PDF costs roughly
 * 1.5–3k tokens a page, so longer ones are left for the model to open itself.
 */
export const maxShownPdfBytes = 10 * 1024 * 1024;
export const maxShownPdfPages = 20;
export const maxShownTextBytes = 50 * 1024;

/** Longest file name kept, in characters, extension included. */
const maxNameChars = 100;

/**
 * A file name that's safe to create in the inbox: no directories, no control
 * characters, not hidden, not too long. Falls back when nothing is left.
 */
export function safeFileName(name: string | undefined, fallback: string) {
  const cleaned = Array.from(
    (name ?? "")
      .normalize("NFC")
      .split(/[/\\]/)
      .at(-1)
      ?.replace(/\p{Cc}|\p{Cf}/gu, "")
      .trim()
      .replace(/^[.\s]+/, "") ?? "",
  );
  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= maxNameChars) return cleaned.join("");
  // Too long: shorten the stem and keep a short extension.
  const text = cleaned.join("");
  const dot = text.lastIndexOf(".");
  const extension =
    dot > 0 && text.length - dot <= 10 ? Array.from(text.slice(dot)) : [];
  return [
    ...cleaned.slice(0, maxNameChars - extension.length),
    ...extension,
  ].join("");
}

const extensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
};

/** The name for a file sent without one, e.g. `photo-140312.jpg`. */
export function fallbackName(attachment: Attachment, localTime: string) {
  const extension = extensions[attachment.mimeType ?? ""] ?? "";
  return `${attachment.kind}-${localTime}${extension}`;
}

// Everything reaches the shell through environment variables, never inside
// the command text. `set -C` makes `>` fail on an existing file, so creating
// the empty placeholder claims the name even against a concurrent save.
const reserveScript = `
dir="$HOME/$DIR"
mkdir -p -- "$dir" || exit 1
stem="\${NAME%.*}"; ext="\${NAME##*.}"
if [ "$stem" = "$NAME" ] || [ -z "$stem" ]; then stem="$NAME"; ext=""; else ext=".$ext"; fi
set -C
n=1; candidate="$NAME"
while ! { : > "$dir/$candidate"; } 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -gt 999 ] && { echo "no free file name in $dir" >&2; exit 1; }
  candidate="$stem ($n)$ext"
done
printf '%s' "$candidate"`;

const pdfInfoScript = `pdfinfo -- "$HOME/$FILE" 2>/dev/null | awk '/^Pages:/ { p = $2 } /^Encrypted:/ { e = $2 } END { print p + 0, e }'`;

const textTypes = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
]);
const textExtensions =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|ics|vcf|html?|css|js|ts|py|sh|toml|ini)$/i;

function isImage(attachment: Attachment) {
  return (
    attachment.kind === "photo" ||
    (attachment.mimeType?.startsWith("image/") ?? false)
  );
}

function isPdf(attachment: Attachment, path: string) {
  return attachment.mimeType === "application/pdf" || /\.pdf$/i.test(path);
}

function isText(attachment: Attachment, path: string) {
  const type = attachment.mimeType ?? "";
  return (
    type.startsWith("text/") || textTypes.has(type) || textExtensions.test(path)
  );
}

export interface AttachmentDeps {
  vm: VmClient;
  telegram: TelegramFiles;
  blobs: BlobStore;
}

/** The `save_attachment` job. */
export function saveAttachmentHandler(deps: AttachmentDeps): JobHandler {
  return async ({ job, db, logger }) => {
    const { inboundItemId } = z
      .object({ inboundItemId: z.string() })
      .parse(job.payload);
    const [item] = await db
      .select({
        userId: inboundItems.userId,
        payload: inboundItems.payload,
        occurredAt: inboundItems.occurredAt,
        pending: inboundItems.pending,
        timezone: users.timezone,
      })
      .from(inboundItems)
      .innerJoin(users, eq(users.id, inboundItems.userId))
      .where(eq(inboundItems.id, inboundItemId));
    if (!item?.pending) return;
    const payload = userMessagePayloadSchema.parse(item.payload);
    const attachment = payload.attachment;
    if (!attachment) {
      await release(db, inboundItemId, item.userId, payload);
      return;
    }

    let result: Attachment;
    try {
      result = await saveAttachment(
        { ...deps, db, logger },
        { id: inboundItemId, ...item, payload, attachment },
      );
    } catch (error) {
      // Retried with backoff; the last attempt gives up so the message isn't
      // held forever, and the model hears the file couldn't be saved.
      if (job.attempts < job.maxAttempts) throw error;
      logger.error({ err: error }, "saving an attachment failed; giving up");
      result = withoutSaved(attachment, "failed");
    }
    await release(db, inboundItemId, item.userId, {
      ...payload,
      attachment: result,
    });
  };
}

async function saveAttachment(
  deps: AttachmentDeps & { db: DbOrTx; logger: Logger },
  item: {
    id: string;
    userId: string;
    occurredAt: Date;
    timezone: string;
    payload: UserMessagePayload;
    attachment: Attachment;
  },
): Promise<Attachment> {
  const { vm, telegram, db, logger } = deps;
  const { userId, attachment } = item;
  if (attachment.size !== undefined && attachment.size > maxDownloadBytes)
    return withoutSaved(attachment, "too_large");
  const bytes = await telegram.download(attachment.telegramFileId);
  if (bytes === "too_large") return withoutSaved(attachment, "too_large");

  // The name is reserved once and remembered, so a retry reuses it.
  let path = attachment.path;
  if (!path) {
    const local = formatInTimeZone(item.occurredAt, item.timezone);
    const dir = `inbox/${local.slice(0, 10)}`;
    const name = safeFileName(
      attachment.fileName,
      fallbackName(attachment, local.slice(11, 19).replaceAll(":", "")),
    );
    const reserved = await vm.exec(userId, {
      cmd: reserveScript,
      env: { DIR: dir, NAME: name },
      timeoutMs: 10_000,
    });
    if (reserved.exitCode !== 0 || !reserved.stdout)
      throw new Error(
        `reserving a file name failed: ${reserved.stderr.trim()}`,
      );
    path = `~/${dir}/${reserved.stdout}`;
    await db
      .update(inboundItems)
      .set({
        payload: { ...item.payload, attachment: { ...attachment, path } },
      })
      .where(eq(inboundItems.id, item.id));
  }
  const relative = path.slice(2);
  await vm.writeFile(userId, relative, bytes);

  const saved: Attachment = {
    ...attachment,
    status: "saved",
    path,
    size: bytes.length,
  };
  // The file is saved either way; showing it is a bonus.
  const shown = await prepareShown(
    deps,
    userId,
    { ...saved, path },
    bytes,
  ).catch((error: unknown) => {
    logger.warn({ err: error, path }, "preparing a file for the model failed");
    return undefined;
  });
  return shown ? { ...saved, shown } : saved;
}

/** The copy of a file the model sees with the message, if it can read it directly. */
async function prepareShown(
  { vm, blobs, logger }: AttachmentDeps & { logger: Logger },
  userId: string,
  attachment: Attachment & { path: string },
  bytes: Uint8Array,
): Promise<Attachment["shown"]> {
  const { path } = attachment;
  if (isImage(attachment)) {
    const image = await showImage({ vm, logger, userId }, path);
    if ("error" in image) return undefined;
    const blobKey = await blobs.put(Buffer.from(image.data, "base64"));
    return { blobKey, as: "image", mediaType: image.mediaType };
  }
  if (isPdf(attachment, path)) {
    if (bytes.length > maxShownPdfBytes) return undefined;
    const info = await vm.exec(userId, {
      cmd: pdfInfoScript,
      env: { FILE: path.slice(2) },
      timeoutMs: 10_000,
    });
    const [pages = "0", encrypted = ""] = info.stdout.trim().split(/\s+/);
    const count = Number(pages);
    if (count < 1 || count > maxShownPdfPages || encrypted === "yes")
      return undefined;
    const blobKey = await blobs.put(bytes);
    return { blobKey, as: "pdf", mediaType: "application/pdf" };
  }
  if (isText(attachment, path) && bytes.length <= maxShownTextBytes) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
    if (text.includes("\0")) return undefined;
    const blobKey = await blobs.put(bytes);
    return { blobKey, as: "text", mediaType: "text/plain" };
  }
  return undefined;
}

function withoutSaved(
  attachment: Attachment,
  status: "too_large" | "failed",
): Attachment {
  const rest = { ...attachment, status };
  delete rest.path;
  delete rest.shown;
  return rest;
}

/**
 * Stores the outcome, records a saved file, and lets turns take the item.
 * Guarded on `pending`, so a duplicate run does nothing.
 */
async function release(
  db: DbOrTx,
  inboundItemId: string,
  userId: string,
  payload: UserMessagePayload,
) {
  await db.transaction(async (tx) => {
    const released = await tx
      .update(inboundItems)
      .set({ payload, pending: false })
      .where(
        and(eq(inboundItems.id, inboundItemId), eq(inboundItems.pending, true)),
      )
      .returning({ id: inboundItems.id });
    if (released.length === 0) return;
    const attachment = payload.attachment;
    if (attachment?.status === "saved" && attachment.path)
      await tx.insert(files).values({
        userId,
        vmPath: attachment.path,
        mime: attachment.mimeType ?? "application/octet-stream",
        size: attachment.size ?? 0,
        telegramFileId: attachment.telegramFileId,
      });
    await enqueue(tx, frontTurnJob.type, {
      userId,
      dedupeKey: frontTurnJob.dedupeKey(userId),
      delayMs: frontTurnJob.debounceMs,
      onDuplicate: "reschedule",
    });
  });
}
