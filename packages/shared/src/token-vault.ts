/**
 * Encryption at rest for the most sensitive data Winston holds: connected
 * accounts' refresh tokens (docs/design.md §12a, §13).
 *
 * Production uses KMS envelope encryption: `encrypt` gets a fresh data key
 * from `GenerateDataKey`, seals the plaintext with it locally (AES-256-GCM),
 * drops the key and stores the KMS-encrypted data key alongside; `decrypt`
 * has KMS decrypt that key. Local development seals with one key from
 * `.env.local` instead. `context` is non-secret and must match exactly to
 * decrypt: it's KMS's encryption context and the GCM additional data, so a
 * ciphertext only opens for the row it was written for. Ciphertexts name
 * their scheme (`local:v1:…`, `kms:v1:…`), so a vault refuses one it can't
 * open instead of misreading it.
 */
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./json.ts";

export interface TokenVault {
  encrypt(plaintext: string, context: VaultContext): Promise<string>;
  decrypt(ciphertext: string, context: VaultContext): Promise<string>;
}

/** Non-secret facts a ciphertext is bound to, e.g. `{ connectionId }`. */
export type VaultContext = Readonly<Record<string, string>>;

/**
 * Which vault a service uses: `TOKEN_KMS_KEY_ID` in production (the Data
 * stack's tokens key), `TOKEN_ENCRYPTION_KEY` locally (32 random bytes as
 * hex, which setup.sh generates). Exactly one is set.
 */
export const tokenVaultConfigSchema = z.object({
  TOKEN_KMS_KEY_ID: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "expected 64 hex characters (32 bytes)")
    .optional(),
});

export type TokenVaultConfig = z.output<typeof tokenVaultConfigSchema>;

/** The vault the config names: KMS in production, the local key otherwise. */
export function createTokenVault(config: TokenVaultConfig): TokenVault {
  const { TOKEN_KMS_KEY_ID: keyId, TOKEN_ENCRYPTION_KEY: localKey } = config;
  if (keyId !== undefined && localKey !== undefined)
    throw new Error(
      "Set only one of TOKEN_KMS_KEY_ID and TOKEN_ENCRYPTION_KEY.",
    );
  if (keyId !== undefined) return kmsTokenVault(awsKmsDataKeys(), keyId);
  if (localKey !== undefined) return localTokenVault(localKey);
  throw new Error(
    "Set TOKEN_KMS_KEY_ID (production) or TOKEN_ENCRYPTION_KEY (local).",
  );
}

const ivBytes = 12;
const tagBytes = 16;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (part: string | undefined) =>
  Buffer.from(part ?? "", "base64url");
const aad = (context: VaultContext) => Buffer.from(canonicalJson(context));

/** AES-256-GCM with a fresh IV: `[iv, sealed, tag]`. */
function seal(key: Uint8Array, plaintext: string, context: VaultContext) {
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aad(context));
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [b64(iv), b64(sealed), b64(cipher.getAuthTag())];
}

function open(
  key: Uint8Array,
  [iv, sealed, tag]: (string | undefined)[],
  context: VaultContext,
) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv), {
      // A shorter tag would be easier to forge.
      authTagLength: tagBytes,
    })
      .setAAD(aad(context))
      .setAuthTag(unb64(tag));
    return Buffer.concat([
      decipher.update(unb64(sealed)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key, context or tampered bytes all fail authentication.
    throw new Error("The ciphertext didn't authenticate.");
  }
}

/** Splits `scheme:version:…` into its parts, or throws for another scheme. */
function parts(ciphertext: string, scheme: string, count: number) {
  const all = ciphertext.split(":");
  if (all.length !== count + 2 || all.slice(0, 2).join(":") !== scheme)
    throw new Error("Not a ciphertext this vault can open.");
  return all.slice(2);
}

const localScheme = "local:v1";

/** AES-256-GCM with one key from `.env.local`, for development. */
export function localTokenVault(hexKey: string): TokenVault {
  const key = Buffer.from(
    tokenVaultConfigSchema.shape.TOKEN_ENCRYPTION_KEY.unwrap().parse(hexKey),
    "hex",
  );
  return {
    encrypt: (plaintext, context) =>
      Promise.resolve(
        [localScheme, ...seal(key, plaintext, context)].join(":"),
      ),
    decrypt: (ciphertext, context) =>
      Promise.try(() => open(key, parts(ciphertext, localScheme, 3), context)),
  };
}

/** The two KMS calls envelope encryption needs; `awsKmsDataKeys` in production. */
export interface KmsDataKeys {
  /** A fresh AES-256 key, in plaintext and encrypted under `keyId`. */
  generate(
    keyId: string,
    context: VaultContext,
  ): Promise<{ plaintext: Uint8Array; encrypted: Uint8Array }>;
  /** Decrypts a data key `generate` returned, with the same context. */
  decrypt(
    keyId: string,
    encrypted: Uint8Array,
    context: VaultContext,
  ): Promise<Uint8Array>;
}

/** KMS through the AWS SDK; the region and credentials come from the task. */
export function awsKmsDataKeys(client = new KMSClient()): KmsDataKeys {
  return {
    async generate(keyId, context) {
      const { Plaintext, CiphertextBlob } = await client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      );
      if (!Plaintext || !CiphertextBlob)
        throw new Error("KMS returned no data key.");
      return { plaintext: Plaintext, encrypted: CiphertextBlob };
    },
    async decrypt(keyId, encrypted, context) {
      const { Plaintext } = await client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: encrypted,
          EncryptionContext: context,
        }),
      );
      if (!Plaintext) throw new Error("KMS returned no plaintext.");
      return Plaintext;
    },
  };
}

const kmsScheme = "kms:v1";

/**
 * KMS envelope encryption: `kms:v1:<encrypted data key>:<iv>:<sealed>:<tag>`.
 * Every encryption gets its own data key, and every decryption asks KMS; no
 * data keys are cached, since tokens are read rarely enough that the calls
 * cost nothing noticeable (docs/design.md §12a).
 */
export function kmsTokenVault(kms: KmsDataKeys, keyId: string): TokenVault {
  return {
    async encrypt(plaintext, context) {
      const key = await kms.generate(keyId, context);
      try {
        return [
          kmsScheme,
          b64(key.encrypted),
          ...seal(key.plaintext, plaintext, context),
        ].join(":");
      } finally {
        key.plaintext.fill(0);
      }
    },
    async decrypt(ciphertext, context) {
      const [encryptedKey, ...sealed] = parts(ciphertext, kmsScheme, 4);
      const key = await kms.decrypt(keyId, unb64(encryptedKey), context);
      try {
        return open(key, sealed, context);
      } finally {
        key.fill(0);
      }
    },
  };
}
