import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteHost } from "@winston/site-host/host";
import { localSiteHost } from "@winston/site-host/local-host";
import { startLocalSites } from "./server.ts";

const route = {
  script: "site_01test",
  ownerId: "usr_1",
  access: "private" as const,
  paused: false,
};

const worker = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") return Response.json({ hello: url.hostname });
    return env.ASSETS.fetch(request);
  },
};`;

describe("the local site host", () => {
  let dir: string;
  let sites: Awaited<ReturnType<typeof startLocalSites>>;
  let host: SiteHost;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "winston-sites-"));
    sites = await startLocalSites({
      dir,
      domain: "sites.localhost",
      port: 0,
      adminPort: 0,
      admitAll: true,
    });
    host = localSiteHost(sites.adminUrl);
  });

  afterAll(async () => {
    await sites.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a site's Worker and assets answer through the dispatch Worker", async () => {
    await host.putScript(route.script, {
      modules: [{ name: "worker.js", content: worker }],
      assets: [
        {
          path: "/index.html",
          content: new TextEncoder().encode("<h1>Hello</h1>"),
        },
      ],
    });
    await host.setRoute("blog", route);

    expect(await (await sites.fetchSite("blog")).text()).toContain(
      "<h1>Hello</h1>",
    );
    expect(await (await sites.fetchSite("blog", "/api/hello")).json()).toEqual({
      hello: "blog.sites.localhost",
    });
  });

  test("a replaced Worker serves its new version", async () => {
    await host.putScript(route.script, {
      modules: [
        {
          name: "worker.js",
          content: `export default { fetch: () => new Response("v2") };`,
        },
      ],
      assets: [],
    });
    expect(await (await sites.fetchSite("blog")).text()).toBe("v2");
  });

  test("unknown and paused names get their pages", async () => {
    expect((await sites.fetchSite("nothing")).status).toBe(404);
    await host.setRoute("blog", { ...route, paused: true });
    expect((await sites.fetchSite("blog")).status).toBe(503);
    await host.setRoute("blog", route);
  });

  test("a deleted Worker or route leaves no site", async () => {
    await host.deleteScript(route.script);
    expect((await sites.fetchSite("blog")).status).toBe(404);
    await host.setRoute("blog", null);
    expect((await sites.fetchSite("blog")).status).toBe(404);
    // Deleting again is fine.
    await host.deleteScript(route.script);
  });

  test("asset paths can't escape the site", async () => {
    const escape = host.putScript("site_01escape", {
      modules: [{ name: "worker.js", content: worker }],
      assets: [{ path: "/../../oops", content: new Uint8Array() }],
    });
    expect(escape).rejects.toThrow(/escapes the site/);
    await escape.catch(() => undefined);
  });
});
