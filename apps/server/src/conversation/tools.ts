import { z } from "zod";
import type { ModelTools } from "@winston/adapters/models";
import type { OwnerTransaction } from "@winston/adapters/database";
import { taskRequestSchema } from "@winston/contracts/tasks";
import type { TurnValue } from "@winston/contracts/turns";

const create = z.strictObject({ objective: taskRequestSchema.shape.objective });
const status = z.strictObject({ id: z.uuid() });
const cancel = status.extend({ revision: z.number().int().nonnegative() });
const steer = cancel.extend({ objective: taskRequestSchema.shape.objective });

export const conversationTools = {
  create_task: {
    description:
      "Queue requested background work. This only records a task; it does not execute it. Never describe queued work as completed.",
    inputSchema: create,
  },
  task_status: { description: "Read a task's current verified state.", inputSchema: status },
  steer_task: {
    description:
      "Replace an active task's objective with the user's correction at its current revision.",
    inputSchema: steer,
  },
  cancel_task: {
    description: "Cancel an active task at its current revision.",
    inputSchema: cancel,
  },
} satisfies ModelTools;

export const toolContext = JSON.stringify(
  Object.fromEntries(
    Object.entries(conversationTools).map(([name, tool]) => [
      name,
      {
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.inputSchema),
      },
    ]),
  ),
);

export async function executeConversationTool(
  scope: OwnerTransaction,
  call: { name: string; input: unknown },
  key: string,
  sourceMessageIds: string[],
): Promise<TurnValue> {
  const schemas: Record<string, z.ZodType> = {
    create_task: create,
    task_status: status,
    steer_task: steer,
    cancel_task: cancel,
  };
  if (!schemas[call.name]?.safeParse(call.input).success) return { error: "Invalid tool request." };
  if (call.name === "create_task") {
    const input = create.parse(call.input);
    return scope.tasks.create({ ...input, key, sourceMessageIds });
  }
  if (call.name === "task_status") {
    const input = status.parse(call.input);
    const task = await scope.tasks.find(input.id);
    if (!task) return { error: "Task unavailable." };
    return {
      ...task,
      resources: await scope.taskResources.list({ id: task.id, revision: task.revision }),
    };
  }
  if (call.name === "steer_task") {
    const input = steer.parse(call.input);
    const task = await scope.tasks.find(input.id);
    if (
      !task ||
      task.revision !== input.revision ||
      !["queued", "running", "waiting"].includes(task.state)
    )
      return { error: "Task unavailable, finished, or changed. Read its current status first." };
    return scope.tasks.steer(input.id, input.revision, input.objective);
  }
  if (call.name === "cancel_task") {
    const input = cancel.parse(call.input);
    const task = await scope.tasks.find(input.id);
    if (
      !task ||
      task.revision !== input.revision ||
      !["queued", "running", "waiting", "canceled"].includes(task.state)
    )
      return { error: "Task unavailable, finished, or changed. Read its current status first." };
    return scope.tasks.cancel(input.id, input.revision);
  }
  return { error: "Unknown tool." };
}
