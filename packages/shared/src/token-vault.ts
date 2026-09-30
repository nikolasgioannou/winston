/**
 * Encryption at rest for the most sensitive data Winston holds: connected
 * accounts' refresh tokens (docs/design.md §13). Only `api` and `agents` hold
 * a vault.
 *
 * The interface is shaped for KMS envelope encryption (M4): `encrypt` gets a
 * fresh data key from `GenerateDataKey`, seals the plaintext with it locally
 * (AES-256-GCM) and stores the KMS-encrypted data key alongside; `decrypt`
 * has KMS decrypt that key. `context` is non-secret and must match exactly
 * to decrypt: it's KMS's encryption context and the GCM additional data, so
 * a ciphertext only opens for the row it was written for. Ciphertexts name
 * their scheme (`local:v1:…`, later `kms:v1:…`), so a vault refuses one it
 * can't open instead of misreading it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./json.ts";

export interface TokenVault {
  encrypt(plaintext: string, context: VaultContext): Promise<string>;
  decrypt(ciphertext: string, context: VaultContext): Promise<string>;
}

/** Non-secret facts a ciphertext is bound to, e.g. `{ connectionId }`. */
export type VaultContext = Readonly<Record<string, string>>;

/** The local vault's key: 32 random bytes as hex (setup.sh generates it). */
export const localVaultConfigSchema = z.object({
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "expected 64 hex characters (32 bytes)"),
});

const localScheme = "local:v1";
const ivBytes = 12;
const tagBytes = 16;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const aad = (context: VaultContext) => Buffer.from(canonicalJson(context));

/** AES-256-GCM with one key from `.env.local`, for development. */
export function localTokenVault(hexKey: string): TokenVault {
  const key = Buffer.from(
    localVaultConfigSchema.shape.TOKEN_ENCRYPTION_KEY.parse(hexKey),
    "hex",
  );
  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(ivBytes);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(
        aad(context),
      );
      const sealed = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Promise.resolve(
        [localScheme, b64(iv), b64(sealed), b64(cipher.getAuthTag())].join(":"),
      );
    },
    decrypt(ciphertext, context) {
      const parts = ciphertext.split(":");
      if (parts.length !== 5 || parts.slice(0, 2).join(":") !== localScheme)
        return Promise.reject(
          new Error("Not a ciphertext this vault can open."),
        );
      const [iv, sealed, tag] = parts
        .slice(2)
        .map((part) => Buffer.from(part, "base64url"));
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          iv ?? Buffer.alloc(0),
          {
            // A shorter tag would be easier to forge.
            authTagLength: tagBytes,
          },
        )
          .setAAD(aad(context))
          .setAuthTag(tag ?? Buffer.alloc(0));
        return Promise.resolve(
          Buffer.concat([
            decipher.update(sealed ?? Buffer.alloc(0)),
            decipher.final(),
          ]).toString("utf8"),
        );
      } catch {
        // A wrong key, context or tampered bytes all fail authentication.
        return Promise.reject(new Error("The ciphertext didn't authenticate."));
      }
    },
  };
}
