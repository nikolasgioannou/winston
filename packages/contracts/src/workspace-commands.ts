import { z } from "zod";
import { commandInputSchema } from "./commands";
import { workspaceOperationSchema } from "./workspace";

export const workspaceCommandSchema = z.strictObject({
  operation: workspaceOperationSchema.extend({ kind: z.literal("command:execute") }),
  input: commandInputSchema,
  dispatch: z.strictObject({ id: z.uuid(), token: z.string().regex(/^wda_[A-Za-z0-9_-]{43}$/) }),
});
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;

export const workspaceCommandToolInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  command: commandInputSchema,
});
