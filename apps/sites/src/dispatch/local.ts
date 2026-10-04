import { importSitePassKey } from "@winston/site-host/pass";
import { dispatch } from "./handler.ts";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  SITES_DOMAIN: string;
  WEB_PUBLIC_URL: string;
  /** Verifies site passes: the public half of the site's `SITES_PASS_KEY`. */
  SITES_PASS_PUBLIC_KEY: string;
  ROUTES: { get(key: string, type: "json"): Promise<unknown> };
  /** Each site's Worker, bound by its script name (Miniflare has no dispatch namespaces). */
  [script: string]: unknown;
}

let passKey: Promise<CryptoKey> | undefined;

/** The dispatch Worker as the local host runs it (`apps/sites/src/local`). */
export default {
  fetch: async (request: Request, env: Env) =>
    dispatch(request, {
      domain: env.SITES_DOMAIN,
      webUrl: env.WEB_PUBLIC_URL,
      passKey: await (passKey ??= importSitePassKey(env.SITES_PASS_PUBLIC_KEY)),
      route: (name) => env.ROUTES.get(name, "json"),
      site: (script, siteRequest) => {
        const worker = Object.hasOwn(env, script)
          ? (env[script] as Fetcher)
          : null;
        return worker ? worker.fetch(siteRequest) : null;
      },
    }),
};
