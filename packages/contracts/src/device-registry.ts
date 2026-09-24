import { z } from "zod";
import {
  deviceCapabilitySchema,
  deviceProtocolVersion,
  deviceStatusSchema,
  deviceMessageSchema,
} from "./devices";

export const devicePairingTokenSchema = z.string().regex(/^wdp_[A-Za-z0-9_-]{43}$/);
export const deviceCredentialSchema = z.string().regex(/^wdi_[A-Za-z0-9_-]{43}$/);
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));

export const deviceRegistrationSchema = z.strictObject({
  platform: z.enum(["macos", "windows", "linux"]),
  appVersion: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/),
  protocolVersion: z.literal(deviceProtocolVersion),
  capabilities: z
    .array(deviceCapabilitySchema)
    .max(6)
    .refine((items) => new Set(items).size === items.length),
});

export const registeredDeviceSchema = deviceRegistrationSchema.extend({
  id: z.uuid(),
  name: deviceNameSchema,
  revision: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  revoked: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const devicePairingStartSchema = z.strictObject({ name: deviceNameSchema });
export const deviceRevisionSchema = z.strictObject({ revision: z.number().int().nonnegative() });
export const deviceRenameSchema = deviceRevisionSchema.extend({ name: deviceNameSchema });

export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;
export type RegisteredDevice = z.infer<typeof registeredDeviceSchema>;
export const registeredDeviceListSchema = z.array(registeredDeviceSchema).max(1000);

export const deviceSessionIdentitySchema = z.strictObject({
  deviceId: deviceMessageSchema.shape.deviceId,
  sessionId: deviceMessageSchema.shape.sessionId,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type DeviceSessionIdentity = z.infer<typeof deviceSessionIdentitySchema>;
export const deviceSessionSchema = deviceSessionIdentitySchema.extend({
  expiresAt: z.iso.datetime(),
});
export const deviceSessionWelcomeSchema = deviceSessionSchema.extend({
  kind: z.literal("session"),
  version: z.literal(deviceProtocolVersion),
});
export const devicePresenceSchema = z.strictObject({
  deviceId: z.uuid(),
  status: z.enum(["unreachable", ...deviceStatusSchema.options]),
  lastSeenAt: z.iso.datetime().nullable(),
});
