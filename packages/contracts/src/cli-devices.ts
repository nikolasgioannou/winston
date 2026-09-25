import { z } from "zod";
import { deviceOperationSchema } from "./devices";
import { deviceExecutionSchema, deviceOutputCursorSchema } from "./device-executions";
import { artifactSchema, artifactMetadataSchema } from "./artifacts";
import { deviceFileWriteRequestSchema } from "./device-file-writes";

export const deviceCommandTimeoutMs = 60_000;
export const cliDeviceRequestSchema = z.discriminatedUnion("command", [
  deviceFileWriteRequestSchema.extend({ command: z.literal("devices.write") }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("devices.read"),
    id: z.uuid(),
    key: z.string().min(1).max(100),
    path: deviceOperationSchema.options[1].shape.path,
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("devices.command"),
    id: z.uuid(),
    key: z.string().min(1).max(100),
    operation: deviceOperationSchema.options[0].refine(
      (operation) => new TextEncoder().encode(JSON.stringify(operation)).byteLength <= 12_000,
    ),
  }),
  z.strictObject({
    version: z.literal(1),
    command: z.literal("devices.result"),
    id: z.uuid(),
    after: deviceOutputCursorSchema.default(-1),
  }),
]);
export type CliDeviceRequest = z.infer<typeof cliDeviceRequestSchema>;
export const cliDeviceResultSchema = z.strictObject({
  id: z.uuid(),
  executionId: z.uuid(),
  deviceId: z.uuid(),
  state: deviceExecutionSchema.shape.state,
  exitCode: z.number().int().min(0).max(255).nullable(),
  output: z
    .array(
      z.strictObject({
        sequence: z.number().int().nonnegative(),
        stream: z.enum(["stdout", "stderr"]),
        text: z.string().max(16_384),
      }),
    )
    .max(16),
  afterSequence: deviceOutputCursorSchema,
  hasMore: z.boolean(),
  artifact: artifactMetadataSchema
    .pick({ name: true, mediaType: true, size: true, sha256: true })
    .extend({
      id: artifactSchema.shape.id,
      revision: artifactSchema.shape.revision,
    })
    .optional(),
});
