import { z } from "zod";
import { authorizationRequestSchema } from "./authorization";
import { userMessageSchema } from "./messages";

export const responsibilityPurposeSchema = z.strictObject({
  purpose: z.string().trim().min(1).max(4000),
  scope: z.array(authorizationRequestSchema).max(100),
  sourceMessageIds: z.array(z.uuid()).max(100),
});
export const responsibilityProposalSchema = responsibilityPurposeSchema.extend({
  key: z.string().min(1).max(200),
});
export const responsibilitySchema = responsibilityPurposeSchema
  .omit({ sourceMessageIds: true })
  .extend({
    id: z.uuid(),
    ownerId: z.uuid(),
    revision: z.number().int().nonnegative(),
    state: z.enum(["proposed", "active", "paused", "ended"]),
    sources: z
      .array(z.strictObject({ messageId: z.uuid(), revision: z.number().int().nonnegative() }))
      .max(100),
    agreement: z
      .strictObject({ proposalRevision: z.number().int().nonnegative(), at: z.iso.datetime() })
      .nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  });
export type Responsibility = z.infer<typeof responsibilitySchema>;
export type ResponsibilityProposal = z.infer<typeof responsibilityProposalSchema>;

export const ownerResponsibilityProposalSchema = responsibilityProposalSchema
  .omit({ sourceMessageIds: true })
  .extend({ key: z.string().min(1).max(196) });
export const ownerResponsibilityRevisionSchema = z.strictObject({
  revision: responsibilitySchema.shape.revision,
});
export const ownerResponsibilityEditSchema = ownerResponsibilityProposalSchema
  .omit({ key: true })
  .extend(ownerResponsibilityRevisionSchema.shape);
export const responsibilityListSchema = z.strictObject({
  items: z.array(responsibilitySchema).max(100),
  next: z.uuid().nullable(),
});

const sourceReferenceSchema = z.strictObject({
  messageId: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export const responsibilitySourceSchema = z.discriminatedUnion("status", [
  sourceReferenceSchema.extend({
    status: z.literal("current"),
    kind: z.enum(["text", "caption", "attachment", "voice"]),
    text: z.string().max(4000),
    transcript: z.string().max(4000).nullable(),
    truncated: z.boolean(),
    sentAt: userMessageSchema.shape.sentAt,
  }),
  sourceReferenceSchema.extend({ status: z.enum(["changed", "unavailable"]) }),
]);
export const responsibilitySourcesSchema = z.strictObject({
  id: z.uuid(),
  revision: responsibilitySchema.shape.revision,
  items: z.array(responsibilitySourceSchema).max(100),
});
export const responsibilityHistorySchema = z.strictObject({
  items: z.array(responsibilitySchema).max(10),
  next: responsibilitySchema.shape.revision.nullable(),
});
