/**
 * Site passes (docs/design.md §9a): what lets a browser into a private site.
 * The site (`runwinston.com`) signs them with an Ed25519 key only it holds;
 * the dispatch Worker verifies them with the public key, so it holds no
 * secret. `<base64url JSON payload>.<base64url signature>`.
 *
 * Web-standard only (WebCrypto, no Buffer), because the dispatch Worker
 * imports it. Signing is in `pass-sign.ts`.
 */
export interface SitePass {
  /** The signed-in user it was issued to. */
  sub: string;
  /** The site name it opens. */
  site: string;
  /** Matches the nonce cookie the site set before sending the browser to sign in. */
  nonce: string;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
}

/** How long a pass (and so the cookie holding it) lasts. */
export const sitePassMs = 30 * 24 * 60 * 60 * 1000;

export function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The verifying key, from its raw 32 bytes in base64url. */
export function importSitePassKey(publicKey: string) {
  return crypto.subtle.importKey(
    "raw",
    fromBase64url(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/** The pass, if it's correctly signed, well formed and unexpired; otherwise null. */
export async function verifySitePass(
  token: string,
  key: CryptoKey,
  now = Date.now(),
): Promise<SitePass | null> {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64url(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const pass = JSON.parse(
      new TextDecoder().decode(fromBase64url(body)),
    ) as Record<string, unknown>;
    return typeof pass.sub === "string" &&
      typeof pass.site === "string" &&
      typeof pass.nonce === "string" &&
      typeof pass.exp === "number" &&
      pass.exp > now
      ? { sub: pass.sub, site: pass.site, nonce: pass.nonce, exp: pass.exp }
      : null;
  } catch {
    return null;
  }
}
