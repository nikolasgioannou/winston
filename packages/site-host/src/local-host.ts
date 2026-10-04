import type { SiteHost, SiteUsage } from "./host.ts";

/**
 * The dev stack's site host: the `sites` service's admin API
 * (`apps/sites/src/local`), which runs every site in Miniflare.
 */
export function localSiteHost(adminUrl: string): SiteHost {
  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
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
    return response.status === 204 ? undefined : response.json();
  };

  return {
    kind: "local",
    putScript: async (script, { modules, assets, databaseId }) => {
      await call("PUT", `/scripts/${encodeURIComponent(script)}`, {
        modules,
        assets: assets.map(({ path, content }) => ({
          path,
          base64: Buffer.from(content).toString("base64"),
        })),
        databaseId,
      });
    },
    deleteScript: async (script) => {
      await call("DELETE", `/scripts/${encodeURIComponent(script)}`);
    },
    setRoute: async (name, route) => {
      await (route
        ? call("PUT", `/routes/${encodeURIComponent(name)}`, route)
        : call("DELETE", `/routes/${encodeURIComponent(name)}`));
    },
    usage: async (script, from, to) =>
      (await call(
        "GET",
        `/usage/${encodeURIComponent(script)}?from=${from.toISOString()}&to=${to.toISOString()}`,
      )) as SiteUsage,
    databaseSize: async (databaseId) =>
      (
        (await call(
          "GET",
          `/databases/${encodeURIComponent(databaseId)}/size`,
        )) as { bytes: number }
      ).bytes,
    deleteDatabase: async (databaseId) => {
      await call("DELETE", `/databases/${encodeURIComponent(databaseId)}`);
    },
    createDatabase: async (name) =>
      ((await call("POST", "/databases", { name })) as { id: string }).id,
    batchSql: async (databaseId, statements) =>
      (
        (await call(
          "POST",
          `/databases/${encodeURIComponent(databaseId)}/batch`,
          { statements },
        )) as { results: Record<string, unknown>[][] }
      ).results,
  };
}
