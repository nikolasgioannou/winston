/**
 * The `attach` tool (docs/design.md §4 Media, §5; decision #70): sends files
 * from the VM to the user immediately, in order with Winston's streamed
 * messages. Every path is checked before anything is sent, so a bad path
 * comes back as an error the model can explain and fix within the turn.
 */
import type { DbOrTx } from "@winston/db/client";
import { files, outboundMessages } from "@winston/db/schema";
import { formatSize } from "@winston/domain/envelope";
import type { ToolDefinition } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { tool } from "ai";
import { z } from "zod";
import type { OutgoingFile, TelegramSender } from "../telegram/sender.ts";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";

/** Telegram's upload limit for bots. */
export const maxUploadBytes = 50 * 1024 * 1024;
/** Telegram's photo limits; bigger images go as documents, uncompressed. */
export const maxPhotoBytes = 10 * 1024 * 1024;
const maxPhotoDimensions = 10_000;
const maxPhotoRatio = 20;
/** Most files in a media group. */
const maxGroup = 10;

const photoTypes = new Set(["jpg", "jpeg", "png", "webp"]);
const mimeTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const inputSchema = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(maxGroup)
    .describe("Paths on your computer, e.g. ~/Documents/ticket.pdf"),
});

const description =
  "Send files from your computer to the user now: photos, PDFs, anything. Up to 10 files, 50 MB each.";

export const attachDefinition: ToolDefinition = {
  name: "attach",
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

// The path reaches the shell only through an environment variable. The
// files API is confined to the home folder, so paths outside it are refused.
const inspectScript = `
case "$F" in "~") F="$HOME" ;; "~/"*) F="$HOME/\${F#\\~/}" ;; esac
[ -e "$F" ] || { echo missing; exit 0; }
[ -f "$F" ] || { echo not_a_file; exit 0; }
real=$(realpath -- "$F")
case "$real" in "$HOME"/*) ;; *) echo outside_home; exit 0 ;; esac
dims="0 0"
[ -n "$IMAGE" ] && dims=$(identify -format '%w %h' -- "$real[0]" 2>/dev/null || echo "0 0")
printf 'file %s %s\\n%s' "$(stat -c %s -- "$real")" "$dims" "\${real#"$HOME"/}"`;

interface Checked {
  path: string;
  /** Relative to the home folder, for the files API. */
  relative: string;
  name: string;
  size: number;
  mime: string;
  kind: OutgoingFile["kind"];
}

/** Whether Telegram will take an image as a photo; otherwise it goes as a document. */
export function sendsAsPhoto(image: {
  extension: string;
  size: number;
  width: number;
  height: number;
}) {
  const { width, height } = image;
  return (
    photoTypes.has(image.extension) &&
    image.size <= maxPhotoBytes &&
    width > 0 &&
    height > 0 &&
    width + height <= maxPhotoDimensions &&
    Math.max(width, height) / Math.min(width, height) <= maxPhotoRatio
  );
}

/** Consecutive files of the same kind, in groups of up to 10: Telegram can't mix photos and documents in one album. */
export function groupFiles<T extends { kind: string }>(items: readonly T[]) {
  const groups: T[][] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last[0]?.kind === item.kind && last.length < maxGroup)
      last.push(item);
    else groups.push([item]);
  }
  return groups;
}

export function attachTool(context: {
  db: DbOrTx;
  vm: VmClient;
  telegram: TelegramSender;
  logger: Logger;
  userId: string;
  runId: string;
  chatId: number;
}) {
  const { vm, userId } = context;

  const check = async (path: string): Promise<Checked | string> => {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    const result = await vm.exec(userId, {
      cmd: inspectScript,
      env: { F: path, IMAGE: photoTypes.has(extension) ? "1" : "" },
      timeoutMs: 10_000,
    });
    const [head = "", relative = ""] = result.stdout.split("\n");
    if (head === "missing") return `there's no file at ${path}`;
    if (head === "not_a_file") return `${path} is a directory, not a file`;
    if (head === "outside_home")
      return `${path} is outside your home folder; copy it there first`;
    const [word, size = "0", width = "0", height = "0"] = head.split(" ");
    if (word !== "file" || !relative)
      throw new Error(result.stderr.trim() || "checking the file failed");
    const bytes = Number(size);
    if (bytes > maxUploadBytes)
      return `${path} is ${formatSize(bytes)}; Telegram only takes files up to 50 MB`;
    if (bytes === 0) return `${path} is empty`;
    return {
      path,
      relative,
      name: relative.split("/").at(-1) ?? relative,
      size: bytes,
      mime: mimeTypes[extension] ?? "application/octet-stream",
      kind: sendsAsPhoto({
        extension,
        size: bytes,
        width: Number(width),
        height: Number(height),
      })
        ? "photo"
        : "document",
    };
  };

  return tool({
    description,
    inputSchema,
    execute: async ({ paths }) => {
      let checked: Checked[];
      try {
        const results = await Promise.all(paths.map(check));
        const problems = results.filter((r) => typeof r === "string");
        if (problems.length > 0) return `Nothing sent: ${problems.join("; ")}.`;
        checked = results as Checked[];
      } catch (error) {
        if (error instanceof GatewayError)
          return "Nothing sent: your computer isn't reachable right now.";
        throw error;
      }

      const sent: string[] = [];
      try {
        for (const group of groupFiles(checked)) {
          const uploads = await Promise.all(
            group.map(async (file) => ({
              kind: file.kind,
              name: file.name,
              bytes: await vm.readFile(userId, file.relative),
            })),
          );
          const results = await context.telegram.sendFiles(
            context.chatId,
            uploads,
          );
          await record(context, group, results);
          sent.push(
            ...group.map(
              (file) =>
                `${file.name} (${formatSize(file.size)}${file.kind === "photo" ? ", as a photo" : ""})`,
            ),
          );
        }
      } catch (error) {
        context.logger.warn({ err: error, paths }, "attach failed");
        const reason =
          error instanceof GatewayError
            ? "your computer isn't reachable right now"
            : error instanceof Error
              ? error.message
              : String(error);
        return sent.length > 0
          ? `Sent ${sent.join(", ")}, then sending the rest failed: ${reason}.`
          : `Nothing sent: ${reason}.`;
      }
      return `Sent ${sent.join(", ")}.`;
    },
  });
}

/** One `outbound_messages` row and one `files` row per sent file. */
async function record(
  context: { db: DbOrTx; userId: string; runId: string },
  group: readonly Checked[],
  results: readonly { messageId: number; fileId: string }[],
) {
  await context.db.transaction(async (tx) => {
    for (const [index, file] of group.entries()) {
      const result = results[index];
      if (!result) continue;
      await tx.insert(outboundMessages).values({
        userId: context.userId,
        runId: context.runId,
        text: `[file: ${file.path}]`,
        telegramMessageIds: [result.messageId],
      });
      await tx.insert(files).values({
        userId: context.userId,
        vmPath: file.path,
        mime: file.mime,
        size: file.size,
        telegramFileId: result.fileId,
      });
    }
  });
}
