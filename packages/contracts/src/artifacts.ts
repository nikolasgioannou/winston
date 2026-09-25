import { z } from "zod";
import { storedObjectSchema } from "./storage";
import { gmailIdSchema } from "./gmail";
import { actionTaskSchema } from "./actions";
import { deviceOperationSchema } from "./devices";
import { deviceFileAuthoritySchema } from "./device-executions";

export const deviceFileSourceSchema = z.strictObject({
  kind: z.literal("device"),
  reference: z.string().min(1).max(2048),
  origin: z.strictObject({
    deviceId: z.uuid(),
    path: deviceOperationSchema.options[1].shape.path,
    executionId: z.uuid(),
    transferId: z.uuid(),
    readActionId: z.uuid(),
  }),
});
export type DeviceFileOrigin = z.infer<typeof deviceFileSourceSchema.shape.origin>;

export const gmailAttachmentSourceSchema = z.strictObject({
  kind: z.literal("connection"),
  reference: z.string().min(1).max(2048),
  origin: z.strictObject({
    service: z.literal("gmail"),
    connectionId: z.uuid(),
    messageId: gmailIdSchema,
    partId: z.string().max(256),
    // JSON encoding preserves control characters that PostgreSQL text cannot store directly.
    originalNameJson: z.string().max(24_578),
    readActionId: z.uuid(),
  }),
});

export const artifactMetadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[\p{Cc}/\\]/u.test(name)),
  mediaType: z.string().min(1).max(255),
  source: z.union([
    z.strictObject({
      kind: z.enum(["telegram", "workspace", "connection", "device"]),
      reference: z.string().min(1).max(2048),
    }),
    gmailAttachmentSourceSchema,
    deviceFileSourceSchema,
  ]),
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
export const gmailAttachmentArtifactSchema = artifactSchema.extend({
  metadata: artifactMetadataSchema.extend({ source: gmailAttachmentSourceSchema }),
});
export const deviceFileArtifactSchema = artifactSchema.extend({
  metadata: artifactMetadataSchema.extend({ source: deviceFileSourceSchema }),
});

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
export const deviceFileUploadSchema = z.strictObject({
  version: z.literal(1),
  authority: deviceFileAuthoritySchema.extend({ operation: z.literal("file.read") }),
  size: z.number().int().min(0).max(maximumPublicationSize),
  sha256: storedObjectSchema.shape.sha256,
});
export type DeviceFileUpload = z.infer<typeof deviceFileUploadSchema>;
export const deviceFileUploadResultSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    status: z.literal("ready"),
    transferId: z.uuid(),
    artifactId: z.uuid(),
    revision: artifactSchema.shape.revision,
    size: deviceFileUploadSchema.shape.size,
    sha256: storedObjectSchema.shape.sha256,
  }),
  z.strictObject({
    version: z.literal(1),
    status: z.enum(["unknown", "denied", "conflict", "invalid_file"]),
    transferId: z.uuid(),
  }),
]);
export type DeviceFileUploadResult = z.infer<typeof deviceFileUploadResultSchema>;
export const artifactTransferTokenSchema = z.string().regex(/^wat_[A-Za-z0-9_-]{43}$/);
export const artifactTransferSchema = z.strictObject({
  ownerId: z.uuid(),
  workspaceId: z.uuid(),
  workspaceRevision: z.number().int().nonnegative(),
  transferId: z.uuid(),
  artifactId: z.uuid(),
  artifactRevision: z.number().int().nonnegative(),
  task: actionTaskSchema,
  size: z.number().int().min(0).max(maximumPublicationSize),
  sha256: storedObjectSchema.shape.sha256,
});
export type ArtifactTransfer = z.infer<typeof artifactTransferSchema>;

export const artifactStageRequestSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().min(1).max(100),
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export const artifactStagePlanSchema = z.strictObject({
  request: artifactStageRequestSchema,
  workspaceId: z.uuid(),
  workspaceRevision: z.number().int().nonnegative(),
  size: artifactTransferSchema.shape.size,
  sha256: storedObjectSchema.shape.sha256,
  sourceReadActionId: z.uuid(),
});
export const artifactStageReceiptSchema = z.strictObject({
  path: z.string().regex(/^\/data\/inbox\/[0-9a-f-]{36}$/),
  size: artifactTransferSchema.shape.size,
  sha256: storedObjectSchema.shape.sha256,
});
export type ArtifactStageRequest = z.infer<typeof artifactStageRequestSchema>;
export type ArtifactStagePlan = z.infer<typeof artifactStagePlanSchema>;
export type ArtifactStageReceipt = z.infer<typeof artifactStageReceiptSchema>;

export const filePublicationSchema = artifactMetadataSchema.omit({ source: true }).extend({
  version: z.literal(1),
  key: z.string().min(1).max(100),
  size: z.number().int().min(0).max(maximumPublicationSize),
});
export type FilePublication = z.infer<typeof filePublicationSchema>;

export const fileDeliveryPlanSchema = z.strictObject({
  version: z.literal(1),
  artifactId: z.uuid(),
  artifactRevision: z.number().int().nonnegative(),
  workspaceId: z.uuid(),
  stagingTransferId: z.uuid().nullable(),
  botId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chatId: z
    .string()
    .regex(/^-?[1-9][0-9]*$/)
    .max(20),
  name: artifactMetadataSchema.shape.name,
  mediaType: artifactMetadataSchema.shape.mediaType,
  size: artifactMetadataSchema.shape.size,
  sha256: artifactMetadataSchema.shape.sha256,
});
export type FileDeliveryPlan = z.infer<typeof fileDeliveryPlanSchema>;

export const deliveryDownloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unavailable") }),
  z.strictObject({ kind: z.literal("expired") }),
  z.strictObject({
    kind: z.literal("ready"),
    id: z.uuid(),
    name: artifactMetadataSchema.shape.name,
    size: artifactMetadataSchema.shape.size,
    expiresAt: z.iso.datetime(),
  }),
]);
export type DeliveryDownload = z.infer<typeof deliveryDownloadSchema>;

export const signedDownloadSchema = z.strictObject({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }),
  name: artifactMetadataSchema.shape.name,
  expiresIn: z.number().int().min(1).max(60),
});
