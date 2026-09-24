import { z } from "zod";
import { taskSchema } from "./tasks";

export const taskChangedSchema = z.strictObject({
  taskId: taskSchema.shape.id,
  revision: taskSchema.shape.revision,
  state: taskSchema.shape.state,
});

export const taskUpdateSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  taskId: z.uuid(),
  revision: taskSchema.shape.revision,
  state: z.enum(["succeeded", "failed", "waiting"]),
  handoffId: z.uuid().optional(),
  responsibilityId: z.uuid().optional(),
  objectivePreview: z.string().max(500),
  resultPreview: z.string().max(8000),
  resultTruncated: z.boolean(),
});

export const taskUpdateIdsSchema = z.array(taskUpdateSchema.shape.id).max(20);
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
