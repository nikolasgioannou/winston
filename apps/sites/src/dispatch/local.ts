import { admitNobody, dispatch } from "./handler.ts";

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  SITES_DOMAIN: string;
  /** Tests only, until owners can sign in (901702): lets every request in. */
  ADMIT_ALL?: string;
  ROUTES: { get(key: string, type: "json"): Promise<unknown> };
  /** Each site's Worker, bound by its script name (Miniflare has no dispatch namespaces). */
  [script: string]: unknown;
}

/** The dispatch Worker as the local host runs it (`apps/sites/src/local`). */
export default {
  fetch: (request: Request, env: Env) =>
    dispatch(request, {
      domain: env.SITES_DOMAIN,
      route: (name) => env.ROUTES.get(name, "json"),
      site: (script, siteRequest) => {
        const worker = Object.hasOwn(env, script)
          ? (env[script] as Fetcher)
          : null;
        return worker ? worker.fetch(siteRequest) : null;
      },
      admit: env.ADMIT_ALL ? () => Promise.resolve(true) : admitNobody,
    }),
};
