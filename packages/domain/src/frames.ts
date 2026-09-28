/**
 * The websocket protocol between `winstond` and `gateway` (docs/design.md
 * §15): JSON frames, each with a unique `id` and a `type`. A response names
 * the frame it answers in `replyTo`. Each ticket that needs a frame type
 * adds it here (exec, files, RPC and screencast arrive with theirs).
 */
import { z } from "zod";

const frameId = z.string().min(1).max(64);

const base = { id: frameId };

// vm → gateway

/** The first frame on every connection: who the VM is running. */
export const helloFrame = z.object({
  ...base,
  type: z.literal("hello"),
  /** Null until the VM has a CLI. */
  cliVersion: z.string().min(1).max(64).nullable(),
  winstondVersion: z.string().min(1).max(64),
  capabilities: z.array(z.string().max(64)).max(64),
});

// gateway → vm

/**
 * Sent once, right after a VM registers: its long-lived VM token, to store
 * at /etc/winstond/token. The registration token is burned.
 */
export const registeredFrame = z.object({
  ...base,
  type: z.literal("registered"),
  vmToken: z.string().min(1),
});

/** A frame the other side couldn't accept, such as a malformed one. */
export const errorFrame = z.object({
  ...base,
  type: z.literal("error"),
  replyTo: frameId.optional(),
  code: z.enum(["invalid_frame", "unsupported"]),
  message: z.string(),
});

/** Runs a shell command as `winston`. The frame's `id` is the exec id. */
export const execFrame = z.object({
  ...base,
  type: z.literal("exec"),
  cmd: z.string().min(1),
  /** Defaults to /home/winston. */
  cwd: z.string().min(1).optional(),
  /** The command's whole environment on top of a clean base, e.g. `WINSTON_RUN_TOKEN`. */
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string()),
  timeoutMs: z.number().int().positive().max(3_600_000),
});

/** Asks for a finished (or still running) command's result, after a reconnect. */
export const execFetchFrame = z.object({
  ...base,
  type: z.literal("exec.fetch"),
  execId: frameId,
});

/** A chunk of a running command's output, in order per stream. */
export const execOutputFrame = z.object({
  ...base,
  type: z.literal("exec.output"),
  execId: frameId,
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
});

/** A command finished. */
export const execExitFrame = z.object({
  ...base,
  type: z.literal("exec.exit"),
  execId: frameId,
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  /** Output past the cap was dropped. */
  truncated: z.boolean(),
});

/** The whole result of a command, answering `exec.fetch`. */
export const execResultFrame = z.object({
  ...base,
  type: z.literal("exec.result"),
  execId: frameId,
  /** False when the VM has no record of it (never ran, or older than 5 minutes). */
  found: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

/**
 * File transfers (§15), confined to /home/winston and at most 50 MB. The
 * request frame's `id` is the transfer id. Bytes move as base64 chunks of at
 * most 256 KiB, numbered from 0, with a SHA-256 over the whole file.
 */
export const fileReadFrame = z.object({
  ...base,
  type: z.literal("file.read"),
  path: z.string().min(1).max(4096),
});

/** Starts an upload; `size` and `sha256` are checked before the file is renamed into place. */
export const fileWriteFrame = z.object({
  ...base,
  type: z.literal("file.write"),
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const fileChunkFrame = z.object({
  ...base,
  type: z.literal("file.chunk"),
  transferId: frameId,
  seq: z.number().int().nonnegative(),
  data: z.string(),
});

/** The last chunk of an upload was sent. */
export const fileEndFrame = z.object({
  ...base,
  type: z.literal("file.end"),
  transferId: frameId,
});

/** A read finished sending, or an upload was written into place. */
export const fileDoneFrame = z.object({
  ...base,
  type: z.literal("file.done"),
  transferId: frameId,
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const fileErrorFrame = z.object({
  ...base,
  type: z.literal("file.error"),
  transferId: frameId,
  code: z.enum([
    "outside_home",
    "not_found",
    "not_a_file",
    "too_large",
    "mismatch",
    "permission_denied",
    "failed",
  ]),
  message: z.string(),
});

// both ways

/** Liveness, every 20 s from the VM; `last_seen_at` is updated. */
export const pingFrame = z.object({ ...base, type: z.literal("ping") });
export const pongFrame = z.object({
  ...base,
  type: z.literal("pong"),
  replyTo: frameId,
});

export const vmToGatewayFrame = z.discriminatedUnion("type", [
  helloFrame,
  execOutputFrame,
  execExitFrame,
  execResultFrame,
  fileChunkFrame,
  fileDoneFrame,
  fileErrorFrame,
  pingFrame,
  pongFrame,
  errorFrame,
]);

export const gatewayToVmFrame = z.discriminatedUnion("type", [
  registeredFrame,
  execFrame,
  execFetchFrame,
  fileReadFrame,
  fileWriteFrame,
  fileChunkFrame,
  fileEndFrame,
  pingFrame,
  pongFrame,
  errorFrame,
]);

export type VmToGatewayFrame = z.infer<typeof vmToGatewayFrame>;
export type GatewayToVmFrame = z.infer<typeof gatewayToVmFrame>;
export type FileErrorCode = z.infer<typeof fileErrorFrame>["code"];
export type ExecResult = Omit<
  z.infer<typeof execResultFrame>,
  "id" | "type" | "execId" | "found"
>;

/** Parses one text frame, or explains why it isn't one. */
export function parseFrame<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
) {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false as const, error: "not JSON" };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true as const, frame: result.data }
    : { ok: false as const, error: z.prettifyError(result.error) };
}

/** A fresh frame id. */
export function newFrameId() {
  return crypto.randomUUID();
}
