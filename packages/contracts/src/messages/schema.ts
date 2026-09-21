import { z } from "zod";
import { validTimezone } from "../timezone";
import { isXmlText } from "./xml";

const text = z.string().refine(isXmlText, "Text contains unsupported XML characters.");
const id = z.uuid();

export const timestampSchema = z.strictObject({
  instant: z.iso.datetime(),
  timezone: z.string().refine(validTimezone),
  offset: z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
});

const attachmentFields = {
  id,
  filename: text,
  mediaType: text,
};

export const attachmentSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...attachmentFields, state: z.literal("pending") }),
  z.strictObject({ ...attachmentFields, state: z.literal("failed"), reason: text }),
  z.strictObject({
    ...attachmentFields,
    state: z.literal("staged"),
    artifactId: id,
    workspaceId: id,
    path: text.refine(
      (value) => value.startsWith("/") && !value.split("/").includes(".."),
      "Staged paths must be absolute workspace paths without traversal.",
    ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.iso.datetime(),
  }),
]);

export const transcriptSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("pending"), attachmentId: id }),
  z.strictObject({ state: z.literal("failed"), attachmentId: id, reason: text }),
  z.strictObject({
    state: z.literal("ready"),
    attachmentId: id,
    text,
    provider: text.min(1),
    model: text.min(1),
    completedAt: z.iso.datetime(),
  }),
]);

export const metadataSchema = z.strictObject({
  attachments: z.array(attachmentSchema),
  transcript: transcriptSchema.optional(),
  references: z.array(z.strictObject({ kind: z.enum(["task", "context"]), id })),
});

export const userMessageSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("user-message"),
    ownerId: id,
    conversationId: id,
    messageId: id,
    eventId: id,
    revision: z.number().int().nonnegative(),
    sentAt: timestampSchema,
    provider: z.strictObject({
      name: z.literal("telegram"),
      messageId: text.min(1),
      sentAt: z.iso.datetime(),
      editedAt: z.iso.datetime().optional(),
    }),
    input: z.strictObject({ kind: z.enum(["text", "caption", "attachment", "voice"]), text }),
    metadata: metadataSchema,
  })
  .superRefine((message, context) => {
    const ids = message.metadata.attachments.map((attachment) => attachment.id);

    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Attachment IDs must be unique." });
    }
    if (message.metadata.transcript && !ids.includes(message.metadata.transcript.attachmentId)) {
      context.addIssue({ code: "custom", message: "Transcript must reference an attachment." });
    }
  });

export const autonomousEventSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("autonomous-event"),
  ownerId: id,
  conversationId: id,
  eventId: id,
  occurredAt: timestampSchema,
  trigger: z.enum(["schedule", "worker-result", "responsibility"]),
  referenceId: id,
  detail: text,
});

export type UserMessage = z.infer<typeof userMessageSchema>;
export type MessageMetadata = z.infer<typeof metadataSchema>;
export type AutonomousEvent = z.infer<typeof autonomousEventSchema>;
