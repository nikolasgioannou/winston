import { importSitePassKey } from "@winston/site-host/pass";
import { dispatch } from "./handler.ts";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  SITES_DOMAIN: string;
  WEB_PUBLIC_URL: string;
  /** Verifies site passes: the public half of `SITES_PASS_KEY`, set at deploy. */
  SITES_PASS_PUBLIC_KEY: string;
  ROUTES: { get(key: string, type: "json"): Promise<unknown> };
  /** Every site's Worker (the `winston-sites` dispatch namespace). */
  DISPATCHER: {
    get(
      name: string,
      args?: Record<string, unknown>,
      options?: { limits?: { cpuMs?: number; subRequests?: number } },
    ): Fetcher;
  };
}

let passKey: Promise<CryptoKey> | undefined;

/**
 * The dispatch Worker on Cloudflare (docs/design.md §9a), on
 * `*.runwinston.app/*`: `wrangler.jsonc`, deployed by `bun run
 * sites:deploy-dispatch`.
 */
export default {
  fetch: async (request: Request, env: Env) =>
    dispatch(request, {
      domain: env.SITES_DOMAIN,
      webUrl: env.WEB_PUBLIC_URL,
      passKey: await (passKey ??= importSitePassKey(env.SITES_PASS_PUBLIC_KEY)),
      route: (name) => env.ROUTES.get(name, "json"),
      site: async (script, siteRequest, limits) => {
        try {
          return await env.DISPATCHER.get(script, {}, { limits }).fetch(
            siteRequest,
          );
        } catch (error) {
          // A route whose Worker is gone reads as no site; anything else is the site failing.
          if (
            error instanceof Error &&
            error.message.startsWith("Worker not found")
          )
            return null;
          throw error;
        }
      },
    }),
};
