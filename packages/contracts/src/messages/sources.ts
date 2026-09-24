import { z } from "zod";
import { timestampSchema } from "./schema";

export const messageSourceReferenceSchema = z.strictObject({
  messageId: z.uuid(),
  revision: z.number().int().nonnegative(),
});

export const versionedMessageSourceSchema = z.discriminatedUnion("status", [
  messageSourceReferenceSchema.extend({
    status: z.literal("current"),
    kind: z.enum(["text", "caption", "attachment", "voice"]),
    text: z.string().max(4000),
    transcript: z.string().max(4000).nullable(),
    truncated: z.boolean(),
    sentAt: timestampSchema,
  }),
  messageSourceReferenceSchema.extend({ status: z.enum(["changed", "unavailable"]) }),
]);

export const messageSourceSchema = z.union([
  versionedMessageSourceSchema,
  z.strictObject({ messageId: z.uuid(), revision: z.null(), status: z.literal("uncaptured") }),
]);
export type MessageSource = z.infer<typeof messageSourceSchema>;
