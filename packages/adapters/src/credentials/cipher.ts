import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  credentialBindingSchema,
  encryptedCredentialSchema,
  providerGrantSchema,
  type CredentialBinding,
  type EncryptedCredential,
  type ProviderGrant,
} from "@winston/contracts/credentials";

// Keys remain in the trusted process, never in database rows or workspace credentials.
export function createCredentialCipher(activeKeyId: string, input: Record<string, string>) {
  const keys = new Map<string, KeyObject>();
  try {
    for (const [id, encoded] of Object.entries(input)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !/^[A-Za-z0-9+/]{43}=$/.test(encoded))
        throw new Error();
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== 32 || bytes.toString("base64") !== encoded) throw new Error();
      keys.set(id, createSecretKey(bytes));
      bytes.fill(0);
    }
    if (!keys.has(activeKeyId) || keys.size > 10) throw new Error();
  } catch {
    throw new Error("Credential encryption configuration is invalid.");
  }

  function aad(binding: CredentialBinding, keyId: string) {
    const parsed = credentialBindingSchema.parse({
      ownerId: binding.ownerId,
      id: binding.id,
      provider: binding.provider,
      revision: binding.revision,
    });
    return Buffer.from(
      JSON.stringify([1, keyId, parsed.ownerId, parsed.id, parsed.provider, parsed.revision]),
    );
  }

  return {
    activeKeyId,
    encrypt(binding: CredentialBinding, input: ProviderGrant): EncryptedCredential {
      try {
        const grant = providerGrantSchema.parse(input);
        const key = keys.get(activeKeyId);
        if (!key) throw new Error();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
        cipher.setAAD(aad(binding, activeKeyId));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(grant), "utf8"),
          cipher.final(),
        ]);
        return {
          version: 1,
          keyId: activeKeyId,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        };
      } catch {
        throw new Error("Credential encryption failed.");
      }
    },
    decrypt(binding: CredentialBinding, input: EncryptedCredential): ProviderGrant {
      try {
        const document = encryptedCredentialSchema.parse(input);
        const key = keys.get(document.keyId);
        if (!key) throw new Error();
        const ciphertext = Buffer.from(document.ciphertext, "base64");
        if (ciphertext.toString("base64") !== document.ciphertext) throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(document.nonce, "base64"),
          { authTagLength: 16 },
        );
        decipher.setAAD(aad(binding, document.keyId));
        decipher.setAuthTag(Buffer.from(document.tag, "base64"));
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        try {
          return providerGrantSchema.parse(JSON.parse(plaintext.toString("utf8")) as unknown);
        } finally {
          plaintext.fill(0);
        }
      } catch {
        // Never propagate crypto/parser errors that might contain a grant or caller input.
        throw new Error("Credential is unavailable or could not be authenticated.");
      }
    },
  };
}

export function readCredentialCipher(environment: Record<string, string | undefined>) {
  try {
    const active = environment.CREDENTIAL_ACTIVE_KEY;
    const encoded = environment.CREDENTIAL_KEYS;
    if (!active || !encoded) throw new Error();
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const keys: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error();
      keys[id] = value;
    }
    return createCredentialCipher(active, keys);
  } catch {
    throw new Error("Set valid CREDENTIAL_ACTIVE_KEY and CREDENTIAL_KEYS on the trusted service.");
  }
}
