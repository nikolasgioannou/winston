import { z } from "zod";

export const encryptedCredentialSchema = z.strictObject({
  version: z.literal(1),
  keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  ciphertext: z.string().min(4).max(100_000),
});

export const credentialBindingSchema = z.strictObject({
  ownerId: z.uuid(),
  id: z.uuid(),
  provider: z.literal("google"),
  revision: z.number().int().nonnegative(),
});

export const providerGrantSchema = z.strictObject({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
  expiresAt: z.iso.datetime(),
  scopes: z.array(z.string().min(1).max(300)).max(100),
});

export type EncryptedCredential = z.infer<typeof encryptedCredentialSchema>;
export type CredentialBinding = z.infer<typeof credentialBindingSchema>;
export type ProviderGrant = z.infer<typeof providerGrantSchema>;
