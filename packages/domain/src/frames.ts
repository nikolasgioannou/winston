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
  pingFrame,
  pongFrame,
  errorFrame,
]);

export const gatewayToVmFrame = z.discriminatedUnion("type", [
  registeredFrame,
  pingFrame,
  pongFrame,
  errorFrame,
]);

export type VmToGatewayFrame = z.infer<typeof vmToGatewayFrame>;
export type GatewayToVmFrame = z.infer<typeof gatewayToVmFrame>;

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
