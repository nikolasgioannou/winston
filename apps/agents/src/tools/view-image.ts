/**
 * The `view_image` tool (docs/design.md §5): shows the model an image from
 * its computer (screenshots, photos the user sent, downloads). The VM does
 * any conversion with ImageMagick, so the backend only moves bytes.
 */
import type { ToolDefinition } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { tool } from "ai";
import { z } from "zod";
import { GatewayError, type VmClient } from "../vm/gateway-client.ts";

/**
 * Limits for what's sent to the model: Anthropic's sweet spot is at most
 * 1568 px on the long edge and about 1.15 megapixels (roughly 1.5k tokens);
 * larger images are only downscaled on their side anyway. And under 5 MB.
 */
export const maxImageEdge = 1568;
export const maxImagePixels = 1_150_000;
export const maxImageBytes = 4_500_000;

/** Formats the model accepts as they are. */
const acceptedFormats = new Set(["PNG", "JPEG", "GIF", "WEBP"]);
/** Photographic formats become JPEG when converted; everything else becomes PNG. */
const photoFormats = new Set(["JPEG", "HEIC", "HEIF", "AVIF"]);

export interface ImageInfo {
  format: string;
  width: number;
  height: number;
  bytes: number;
}

/** Whether an image can be shown as it is, or must be converted (and to what). */
export function planImage(
  image: ImageInfo,
): { convert: false } | { convert: true; to: "jpeg" | "png" } {
  const fits =
    acceptedFormats.has(image.format) &&
    image.width <= maxImageEdge &&
    image.height <= maxImageEdge &&
    image.width * image.height <= maxImagePixels &&
    image.bytes <= maxImageBytes;
  if (fits) return { convert: false };
  return { convert: true, to: photoFormats.has(image.format) ? "jpeg" : "png" };
}

const mediaTypes: Record<string, string> = {
  PNG: "image/png",
  JPEG: "image/jpeg",
  GIF: "image/gif",
  WEBP: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
};

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("The image's path on your computer, e.g. ~/inbox/photo.jpg."),
});

const description =
  "Look at an image on your computer: a screenshot, a photo, a download. Large or unusual formats are converted first.";

export const viewImageDefinition: ToolDefinition = {
  name: "view_image",
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

// The path always reaches the shell through an environment variable, never
// inside the command text, so it can't inject anything.
const inspectScript = `
case "$IMG" in "~/"*) IMG="$HOME/\${IMG#\\~/}" ;; esac
[ -e "$IMG" ] || { echo missing; exit 0; }
[ -f "$IMG" ] || { echo not_a_file; exit 0; }
info=$(identify -format '%m %w %h' -- "$IMG[0]" 2>/dev/null) || { echo not_an_image; exit 0; }
echo "image $info $(stat -c %s -- "$IMG")"`;

const prepareScript = (out: string, convert: false | "jpeg" | "png") => `
case "$IMG" in "~/"*) IMG="$HOME/\${IMG#\\~/}" ;; esac
mkdir -p ~/.winston/view
${
  convert
    ? `convert -- "$IMG[0]" -auto-orient -resize '${String(maxImageEdge)}x${String(maxImageEdge)}>' -resize '${String(maxImagePixels)}@>' -strip ${convert === "jpeg" ? "-quality 85 " : ""}"$HOME/${out}"`
    : `cp -- "$IMG" "$HOME/${out}"`
}
identify -format '%w %h' -- "$HOME/${out}"`;

type Output =
  { error: string } | { text: string; data: string; mediaType: string };

export function viewImageTool(context: {
  vm: VmClient;
  logger: Logger;
  userId: string;
}) {
  const { vm, userId } = context;
  const run = async (script: string, path: string) => {
    const result = await vm.exec(userId, {
      cmd: script,
      env: { IMG: path },
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "the image command failed");
    return result.stdout.trim();
  };

  return tool({
    description,
    inputSchema,
    execute: async ({ path }): Promise<Output> => {
      try {
        const inspected = await run(inspectScript, path);
        if (inspected === "missing")
          return { error: `There's no file at ${path}.` };
        if (inspected === "not_a_file")
          return { error: `${path} is a directory, not an image.` };
        if (inspected === "not_an_image")
          return { error: `${path} isn't an image I can read.` };
        const [, format = "", width = "0", height = "0", bytes = "0"] =
          inspected.split(/\s+/);
        const image = {
          format,
          width: Number(width),
          height: Number(height),
          bytes: Number(bytes),
        };
        const plan = planImage(image);

        const extension = plan.convert
          ? plan.to === "jpeg"
            ? "jpg"
            : "png"
          : format.toLowerCase();
        const out = `.winston/view/${crypto.randomUUID()}.${extension}`;
        const [shownWidth, shownHeight] = (
          await run(prepareScript(out, plan.convert && plan.to), path)
        ).split(/\s+/);
        const bytesRead = await vm.readFile(userId, out);
        // Best effort: the copy is only needed until it's been read.
        void vm
          .exec(userId, {
            cmd: `rm -f -- "$HOME/${out}"`,
            env: {},
            timeoutMs: 5_000,
          })
          .catch(() => undefined);

        const mediaType =
          mediaTypes[plan.convert ? plan.to : format] ?? "image/png";
        const size = `${String(image.width)}×${String(image.height)} ${format}`;
        const text = plan.convert
          ? `${path} (${size}, shown as ${shownWidth ?? "?"}×${shownHeight ?? "?"} ${plan.to.toUpperCase()})`
          : `${path} (${size})`;
        return {
          text,
          data: Buffer.from(bytesRead).toString("base64"),
          mediaType,
        };
      } catch (error) {
        if (error instanceof GatewayError)
          return {
            error:
              "Your computer isn't reachable right now, so the image couldn't be opened.",
          };
        context.logger.warn({ err: error, path }, "view_image failed");
        return {
          error: `Couldn't open ${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    toModelOutput: ({ output }) =>
      "error" in output
        ? { type: "text", value: output.error }
        : {
            type: "content",
            value: [
              { type: "text", text: output.text },
              {
                type: "file",
                mediaType: output.mediaType,
                data: { type: "data", data: output.data },
              },
            ],
          },
  });
}
