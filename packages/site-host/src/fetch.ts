import { signSitePass, sitePassSigningKey } from "./pass-sign.ts";
import { siteUrl } from "./route.ts";

/** At most this much of a response's body comes back (§11: bounded output). */
export const maxFetchedChars = 8000;

/** How long the pass minted for one fetch lasts. */
const fetchPassMs = 60_000;

/**
 * Requests a site as its owner (docs/design.md §9a, "Checking a site"), so
 * Winston can see whether what he deployed works without a browser signed in
 * to Winston: a pass minted here, for this site and its owner, goes in the
 * cookie the dispatch Worker reads. `connectUrl` overrides where the request
 * goes (the dev stack's sites service, since `*.sites.localhost` doesn't
 * resolve), keeping the site's own address in the Host header.
 */
export async function fetchSiteAsOwner(input: {
  sitesUrl: string;
  connectUrl?: string | undefined;
  passKey: string;
  name: string;
  ownerId: string;
  path: string;
  method: string;
  body?: string | undefined;
  contentType?: string | undefined;
}) {
  const site = new URL(siteUrl(input.sitesUrl, input.name));
  const target = new URL(input.path, input.connectUrl ?? site);
  const pass = signSitePass(
    {
      sub: input.ownerId,
      site: input.name,
      nonce: "fetch",
      exp: Date.now() + fetchPassMs,
    },
    sitePassSigningKey(input.passKey),
  );
  const cookie = `${site.protocol === "https:" ? "__Host-" : ""}winston_site_pass=${pass}`;
  const response = await fetch(target, {
    method: input.method,
    headers: {
      host: site.host,
      cookie,
      ...(input.contentType ? { "content-type": input.contentType } : {}),
    },
    ...(input.body === undefined ? {} : { body: input.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const type = response.headers.get("content-type") ?? "";
  const textual =
    /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(type) ||
    type === "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = textual ? new TextDecoder().decode(bytes) : null;
  return {
    status: response.status,
    contentType: type || null,
    location: response.headers.get("location"),
    size: bytes.byteLength,
    /** The body as text, cut at `maxFetchedChars`; null for binary content. */
    body: text === null ? null : text.slice(0, maxFetchedChars),
    truncated: text !== null && text.length > maxFetchedChars,
  };
}
