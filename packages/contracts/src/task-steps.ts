import { z } from "zod";
import { actionTaskSchema } from "./actions";

const callId = z.string().min(1).max(200);
export const taskStepPayloadSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("model"),
      text: z.string().max(100_000),
      calls: z
        .array(
          z.strictObject({
            id: callId,
            name: z.string().min(1).max(100),
            input: z.json(),
          }),
        )
        .max(16)
        .refine((calls) => new Set(calls.map((call) => call.id)).size === calls.length),
    }),
    z.strictObject({
      kind: z.literal("tool"),
      modelStepId: z.uuid(),
      callId,
      actionId: z.uuid().nullable(),
      result: z.json(),
    }),
  ])
  .refine((payload) => new TextEncoder().encode(JSON.stringify(payload)).length <= 131_072);

export const taskStepRequestSchema = z.strictObject({
  key: z.string().min(1).max(200),
  afterSequence: z.number().int().min(0).max(9999),
  payload: taskStepPayloadSchema,
});

export const taskStepSchema = z.strictObject({
  id: z.uuid(),
  task: actionTaskSchema,
  intentRevision: z.number().int().nonnegative(),
  sequence: z.number().int().min(1).max(10_000),
  request: taskStepRequestSchema,
});

export type TaskStep = z.infer<typeof taskStepSchema>;
export type TaskStepRequest = z.infer<typeof taskStepRequestSchema>;
