import { z } from "zod";
import { actionTaskSchema } from "./actions";
import { deviceMessageSchema } from "./devices";

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
