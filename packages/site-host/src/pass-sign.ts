import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { base64url, type SitePass } from "./pass.ts";

// PKCS#8 framing for a raw Ed25519 seed (RFC 8410).
const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * The signing key, from `SITES_PASS_KEY`: any long random secret (setup.sh's
 * hex, or the one Secrets Manager generates), hashed into the Ed25519 seed.
 */
export function sitePassSigningKey(secret: string) {
  if (secret.length < 32)
    throw new Error("SITES_PASS_KEY must be at least 32 characters");
  const seed = createHash("sha256").update(secret).digest();
  return createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The public key the dispatch Worker verifies with: raw 32 bytes, base64url. */
export function sitePassPublicKey(signingKey: KeyObject) {
  const jwk = createPublicKey(signingKey).export({ format: "jwk" });
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return jwk.x;
}

export function signSitePass(pass: SitePass, signingKey: KeyObject) {
  const body = base64url(new TextEncoder().encode(JSON.stringify(pass)));
  const signature = sign(null, Buffer.from(body), signingKey);
  return `${body}.${base64url(signature)}`;
}
