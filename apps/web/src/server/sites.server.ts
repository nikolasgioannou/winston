import { sitePassMs } from "@winston/site-host/pass";
import { signSitePass, sitePassSigningKey } from "@winston/site-host/pass-sign";
import { isSiteName, siteUrl } from "@winston/site-host/route";

/**
 * Where a private site sends a browser with no pass (docs/design.md §9a):
 * back to the site with a pass for the signed-in user, bound to the nonce the
 * site set. The dispatch Worker decides whether that user is the owner, so
 * this needs nothing about sites but their addresses.
 */
export function sitePassRedirect(input: {
  userId: string;
  query: URLSearchParams;
  passKey: string;
  sitesUrl: string;
  now?: number;
}) {
  const site = input.query.get("site") ?? "";
  const nonce = input.query.get("nonce") ?? "";
  if (!isSiteName(site) || !/^[0-9a-f]{32}$/.test(nonce)) return undefined;
  const pass = signSitePass(
    {
      sub: input.userId,
      site,
      nonce,
      exp: (input.now ?? Date.now()) + sitePassMs,
    },
    sitePassSigningKey(input.passKey),
  );
  const enter = new URL("/__winston/enter", siteUrl(input.sitesUrl, site));
  enter.searchParams.set("pass", pass);
  enter.searchParams.set("path", input.query.get("path") ?? "/");
  return enter.toString();
}
