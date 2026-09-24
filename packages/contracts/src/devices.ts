import { z } from "zod";

export const deviceProtocolVersion = 1;
export const deviceFrameLimit = 262_144;
export const deviceStatusSchema = z.enum(["ready", "locked", "sleeping", "paused"]);

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const text = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => !value.includes("\0"))
    .refine(
      (value) =>
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value),
    );
const path = text(4096).regex(/^\//);

export const deviceCapabilitySchema = z.enum([
  "command",
  "file.read",
  "file.write",
  "observe",
  "input",
  "application",
]);

export const deviceOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    executable: path,
    arguments: z.array(text(8192)).max(128),
    directory: path,
  }),
  z.strictObject({ kind: z.literal("file.read"), path, transferId: identifier }),
  z.strictObject({
    kind: z.literal("file.write"),
    path,
    transferId: identifier,
    overwrite: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("observe"),
    application: text(255).min(1),
    format: z.enum(["accessibility", "screenshot"]),
  }),
  z.strictObject({
    kind: z.literal("input"),
    observationId: identifier,
    elementId: text(128).min(1),
    action: z.enum(["click", "type"]),
    text: text(8192),
  }),
  z.strictObject({
    kind: z.literal("application"),
    application: text(255).min(1),
    action: z.enum(["activate", "raise", "close"]),
    observationId: identifier,
  }),
]);

const execution = {
  executionId: identifier,
  taskId: identifier,
  taskRevision: counter,
};

export const devicePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capabilities"),
    capabilities: z
      .array(deviceCapabilitySchema)
      .max(6)
      .refine((items) => new Set(items).size === items.length),
  }),
  z.strictObject({
    kind: z.literal("heartbeat"),
    status: deviceStatusSchema,
  }),
  z.strictObject({
    kind: z.literal("execute"),
    ...execution,
    deadline: counter,
    operation: deviceOperationSchema,
  }),
  z.strictObject({ kind: z.literal("cancel"), ...execution }),
  z.strictObject({
    kind: z.literal("reconcile"),
    ...execution,
    operation: deviceOperationSchema,
  }),
  z
    .strictObject({
      kind: z.literal("reconciled"),
      ...execution,
      state: z.enum([
        "missing",
        "conflict",
        "unavailable",
        "running",
        "cancel_requested",
        "uncertain",
        "succeeded",
        "failed",
        "canceled",
      ]),
      exitCode: z.number().int().min(0).max(255).nullable(),
    })
    .refine(
      ({ state, exitCode }) =>
        state === "failed" ||
        (state === "succeeded" ? exitCode === null || exitCode === 0 : exitCode === null),
    ),
  z.strictObject({
    kind: z.literal("status"),
    ...execution,
    sequence: counter,
    state: z.enum(["accepted", "running", "succeeded", "failed", "canceled"]),
    exitCode: z.number().int().min(0).max(255).nullable(),
  }),
  z.strictObject({
    kind: z.literal("output"),
    ...execution,
    sequence: counter,
    stream: z.enum(["stdout", "stderr"]),
    text: text(16_384),
  }),
  z.strictObject({
    kind: z.literal("file"),
    ...execution,
    sequence: counter,
    transferId: identifier,
    size: counter,
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("observation"),
    ...execution,
    sequence: counter,
    observationId: identifier,
    transferId: identifier,
    format: z.enum(["accessibility", "screenshot"]),
  }),
  z.strictObject({
    kind: z.literal("error"),
    ...execution,
    sequence: counter,
    code: z.enum([
      "permission_denied",
      "unsupported",
      "unavailable",
      "stale",
      "deadline",
      "failed",
    ]),
    message: text(2000),
  }),
]);

export const deviceMessageSchema = z.strictObject({
  version: z.literal(deviceProtocolVersion),
  messageId: identifier,
  correlationId: identifier,
  deviceId: identifier,
  sessionId: identifier,
  generation: counter,
  payload: devicePayloadSchema,
});

export type DeviceMessage = z.infer<typeof deviceMessageSchema>;
export type DeviceCapability = z.infer<typeof deviceCapabilitySchema>;

export function encodeDeviceMessage(message: DeviceMessage): string {
  const frame = JSON.stringify(deviceMessageSchema.parse(message));
  decodeDeviceMessage(frame);
  return frame;
}

/** Validate before dispatch; framing limits apply to the encoded UTF-8 message. */
export function decodeDeviceMessage(frame: string): DeviceMessage {
  if (new TextEncoder().encode(frame).byteLength > deviceFrameLimit) {
    throw new Error("Device frame exceeds limit");
  }

  return deviceMessageSchema.parse(JSON.parse(frame) as unknown);
}

/** Structural validation does not authorize an operation. Check the current binding too. */
export function acceptsDeviceExecution(
  message: DeviceMessage,
  context: {
    deviceId: string;
    sessionId: string;
    generation: number;
    taskId: string;
    taskRevision: number;
    now: number;
    capabilities: readonly DeviceCapability[];
  },
): boolean {
  const payload = message.payload;

  return (
    payload.kind === "execute" &&
    message.deviceId === context.deviceId &&
    message.sessionId === context.sessionId &&
    message.generation === context.generation &&
    payload.taskId === context.taskId &&
    payload.taskRevision === context.taskRevision &&
    payload.deadline > context.now &&
    context.capabilities.includes(payload.operation.kind)
  );
}
