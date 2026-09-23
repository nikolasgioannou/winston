import { z } from "zod";
import { storedObjectSchema } from "./storage";

export const artifactMetadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[\p{Cc}/\\]/u.test(name)),
  mediaType: z.string().min(1).max(255),
  source: z.strictObject({
    kind: z.enum(["telegram", "workspace", "connection", "device"]),
    reference: z.string().min(1).max(2048),
  }),
  size: storedObjectSchema.shape.size,
  sha256: storedObjectSchema.shape.sha256,
});
export const artifactSchema = z.strictObject({
  id: z.uuid(),
  metadata: artifactMetadataSchema,
  object: storedObjectSchema.extend({ purpose: z.literal("artifact") }),
  state: z.enum(["uploading", "verifying", "ready", "failed", "deleting", "deleted"]),
  revision: z.number().int().nonnegative(),
});
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;
export type Artifact = z.infer<typeof artifactSchema>;

export const inboxTransferTokenSchema = z.string().regex(/^wit_[A-Za-z0-9_-]{43}$/);
export const inboxTransferSchema = z.strictObject({
  ownerId: z.uuid(),
  intakeId: z.uuid(),
  workspaceId: z.uuid(),
  workspaceRevision: z.number().int().nonnegative(),
  artifactId: z.uuid(),
  size: z.number().int().min(0).max(20_000_000),
  sha256: storedObjectSchema.shape.sha256,
});
export type InboxTransfer = z.infer<typeof inboxTransferSchema>;

export const maximumPublicationSize = 50 * 1024 * 1024;
export const filePublicationSchema = artifactMetadataSchema.omit({ source: true }).extend({
  version: z.literal(1),
  key: z.string().min(1).max(100),
  size: z.number().int().min(0).max(maximumPublicationSize),
});
export type FilePublication = z.infer<typeof filePublicationSchema>;
