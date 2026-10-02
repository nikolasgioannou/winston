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

/** The first frame on every connection, and again after a CLI update: who the VM is running. */
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

/**
 * A CLI call to the VM-facing API (§15), forwarded by winstond with the run
 * token the command carried. The gateway answers with `rpc.response`.
 */
export const rpcRequestFrame = z.object({
  ...base,
  type: z.literal("rpc.request"),
  method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  path: z.string().startsWith("/v1/").max(2048),
  body: z.string().nullable(),
  runToken: z.string().max(4096),
});

export const rpcResponseFrame = z.object({
  ...base,
  type: z.literal("rpc.response"),
  replyTo: frameId,
  status: z.number().int().min(100).max(599),
  body: z.string(),
});

// both ways

/** Liveness, every 20 s from the VM; `last_seen_at` is updated. */
/** One signed binary in an update: where to download it, and how to check it. */
const updateBinary = z.object({
  /** A short-lived presigned S3 URL; the VM needs no AWS credentials. */
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** ECDSA P-256 over the SHA-256 (KMS), DER, base64. */
  signature: z.string().min(1).max(512),
});

/**
 * The current VM binaries, for a VM that reported older ones in `hello`
 * (docs/design.md §10). `winstond` replaces whichever differ, then says
 * hello again (or restarts, for its own binary).
 */
export const updateAvailableFrame = z.object({
  ...base,
  type: z.literal("update.available"),
  version: z.string().min(1).max(64),
  binaries: z.object({ winston: updateBinary, winstond: updateBinary }),
});

export const pingFrame = z.object({ ...base, type: z.literal("ping") });
export const pongFrame = z.object({
  ...base,
  type: z.literal("pong"),
  replyTo: frameId,
});

/**
 * Browser handoff (§5): the gateway asks winstond to hold a run's current
 * window for the user (the agent can't act in it meanwhile), and later to
 * let it go. `owner` is how winstond names runs: `front`, or a run id.
 */
export const browserHoldFrame = z.object({
  ...base,
  type: z.literal("browser.hold"),
  owner: z.string().min(1).max(64),
});

/** The window held, or null when the run has no browser window. */
export const browserHeldFrame = z.object({
  ...base,
  type: z.literal("browser.held"),
  replyTo: frameId,
  window: z
    .object({
      windowId: z.string(),
      targetId: z.string(),
      url: z.string(),
    })
    .nullable(),
});

export const browserReleaseFrame = z.object({
  ...base,
  type: z.literal("browser.release"),
  owner: z.string().min(1).max(64),
});

/**
 * The live view of one window's tab: frames come back as binary messages
 * (`screencastMessage`), and input from the page goes the other way.
 */
export const screencastStartFrame = z.object({
  ...base,
  type: z.literal("screencast.start"),
  handoffId: z.string().min(1).max(64),
  targetId: z.string().min(1).max(64),
});

export const screencastStopFrame = z.object({
  ...base,
  type: z.literal("screencast.stop"),
  handoffId: z.string().min(1).max(64),
});

/** The tab went away (closed, or Chrome restarted): the live view is over. */
export const screencastEndedFrame = z.object({
  ...base,
  type: z.literal("screencast.ended"),
  handoffId: z.string().min(1).max(64),
  reason: z.string().max(200),
});

/**
 * What the person does on the live view, in the tab's CSS pixels: a pointer
 * (mouse or a finger, which becomes the mouse), the wheel, a key, or text
 * from the phone's keyboard.
 */
export const viewerInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pointer"),
    action: z.enum(["down", "move", "up"]),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    kind: z.literal("wheel"),
    x: z.number(),
    y: z.number(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.object({
    kind: z.literal("key"),
    key: z.string().min(1).max(32),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(10_000),
  }),
  /**
   * The page's own size (CSS pixels and pixel ratio): the tab is shown at
   * that size while it's watched, so a site lays out for the phone.
   */
  z.object({
    kind: z.literal("viewport"),
    width: z.number().int().min(200).max(4000),
    height: z.number().int().min(200).max(4000),
    scale: z.number().min(1).max(4),
  }),
]);
export type ViewerInput = z.infer<typeof viewerInput>;

export const inputFrame = z.object({
  ...base,
  type: z.literal("input"),
  handoffId: z.string().min(1).max(64),
  input: viewerInput,
});

/** A screencast frame's facts, ahead of its JPEG in the binary message. */
export const screencastHeader = z.object({
  handoffId: z.string().min(1).max(64),
  /** The tab's viewport in CSS pixels, to map the page's touches back. */
  width: z.number(),
  height: z.number(),
});
export type ScreencastHeader = z.infer<typeof screencastHeader>;

/** A binary screencast message: its JSON header, a newline, then the JPEG. */
export function screencastMessage(header: ScreencastHeader, jpeg: Uint8Array) {
  const head = new TextEncoder().encode(`${JSON.stringify(header)}\n`);
  const message = new Uint8Array(head.length + jpeg.length);
  message.set(head);
  message.set(jpeg, head.length);
  return message;
}

/** Reads a binary screencast message; undefined if it isn't one. */
export function parseScreencastMessage(message: Uint8Array) {
  const newline = message.indexOf(10);
  if (newline < 0) return undefined;
  try {
    const header = screencastHeader.parse(
      JSON.parse(new TextDecoder().decode(message.subarray(0, newline))),
    );
    return { header, jpeg: message.subarray(newline + 1) };
  } catch {
    return undefined;
  }
}

export const vmToGatewayFrame = z.discriminatedUnion("type", [
  helloFrame,
  execOutputFrame,
  execExitFrame,
  execResultFrame,
  fileChunkFrame,
  fileDoneFrame,
  fileErrorFrame,
  rpcRequestFrame,
  browserHeldFrame,
  screencastEndedFrame,
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
  rpcResponseFrame,
  updateAvailableFrame,
  browserHoldFrame,
  browserReleaseFrame,
  screencastStartFrame,
  screencastStopFrame,
  inputFrame,
  pingFrame,
  pongFrame,
  errorFrame,
]);

export type VmToGatewayFrame = z.infer<typeof vmToGatewayFrame>;
export type GatewayToVmFrame = z.infer<typeof gatewayToVmFrame>;
export type UpdateAvailableFrame = z.infer<typeof updateAvailableFrame>;
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
