import { z } from "zod";
import { actionTaskSchema } from "./actions";
import { deviceMessageSchema } from "./devices";

export const deviceOutputByteLimit = 3 * 1024 * 1024;
export const deviceOutputChunkLimit = 4096;
export const deviceOutputPageByteLimit = 65_536;
export const deviceOutputCursorSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

export const deviceExecutionSchema = z.strictObject({
  actionId: z.uuid(),
  task: actionTaskSchema,
  message: deviceMessageSchema.refine((message) => message.payload.kind === "execute"),
  state: z.enum([
    "dispatching",
    "accepted",
    "running",
    "unknown",
    "succeeded",
    "failed",
    "canceled",
  ]),
  receipt: deviceMessageSchema.nullable(),
  reconciliation: z
    .strictObject({
      request: deviceMessageSchema.refine((message) => message.payload.kind === "reconcile"),
      response: deviceMessageSchema
        .refine((message) => message.payload.kind === "reconciled")
        .nullable(),
    })
    .nullable()
    .default(null),
});

export type DeviceExecution = z.infer<typeof deviceExecutionSchema>;
