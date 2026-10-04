import type { SiteHost } from "./host.ts";

/**
 * The dev stack's site host: the `sites` service's admin API
 * (`apps/sites/src/local`), which runs every site in Miniflare.
 */
export function localSiteHost(adminUrl: string): SiteHost {
  const call = async (
    method: "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ) => {
    const response = await fetch(new URL(path, adminUrl), {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok)
      throw new Error(
        `local site host: ${method} ${path} failed (${String(response.status)}): ${await response.text()}`,
      );
  };

  return {
    kind: "local",
    putScript: (script, { modules, assets }) =>
      call("PUT", `/scripts/${encodeURIComponent(script)}`, {
        modules,
        assets: assets.map(({ path, content }) => ({
          path,
          base64: Buffer.from(content).toString("base64"),
        })),
      }),
    deleteScript: (script) =>
      call("DELETE", `/scripts/${encodeURIComponent(script)}`),
    setRoute: (name, route) =>
      route
        ? call("PUT", `/routes/${encodeURIComponent(name)}`, route)
        : call("DELETE", `/routes/${encodeURIComponent(name)}`),
  };
}
