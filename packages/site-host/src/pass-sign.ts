import {
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { base64url, type SitePass } from "./pass.ts";

// PKCS#8 framing for a raw Ed25519 seed (RFC 8410).
const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");

/** The signing key, from `SITES_PASS_KEY`: a 32-byte seed in hex. */
export function sitePassSigningKey(seedHex: string) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32)
    throw new Error("SITES_PASS_KEY must be 32 bytes in hex");
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
