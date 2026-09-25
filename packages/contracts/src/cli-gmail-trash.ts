import { z } from "zod";
import { gmailIdSchema } from "./gmail";

const fields = {
  version: z.literal(1),
  accountId: z.uuid(),
  messageId: gmailIdSchema,
  key: z.string().min(1).max(100),
};
export const cliGmailTrashRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...fields, command: z.literal("gmail.trash") }),
  z.strictObject({ ...fields, command: z.literal("gmail.restore") }),
]);
