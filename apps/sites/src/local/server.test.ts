import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SiteHost } from "@winston/site-host/host";
import { localSiteHost } from "@winston/site-host/local-host";
import { applyMigrations, MigrationError } from "@winston/site-host/migrations";
import {
  signSitePass,
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";
import { generateToken, hashToken } from "@winston/shared/tokens";
import { startLocalSites } from "./server.ts";

const route = {
  script: "site_01test",
  ownerId: "usr_owner",
  access: "private" as const,
  shareKeyHash: null,
  paused: false,
};

const worker = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") return Response.json({ hello: url.hostname });
    return env.ASSETS.fetch(request);
  },
};`;

const signingKey = sitePassSigningKey(randomBytes(32).toString("hex"));
const pass = (sub = "usr_owner", nonce = "n") =>
  signSitePass(
    { sub, site: "blog", nonce, exp: Date.now() + 60_000 },
    signingKey,
  );
const owner = `winston_site_pass=${pass()}`;

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
      webUrl: "http://localhost:3002",
      passPublicKey: sitePassPublicKey(signingKey),
    });
    host = localSiteHost(sites.adminUrl);
  });

  afterAll(async () => {
    await sites.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("the owner reaches a site's Worker and assets through the dispatch Worker", async () => {
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

    expect(await (await sites.fetchSite("blog", "/", owner)).text()).toContain(
      "<h1>Hello</h1>",
    );
    const api = await sites.fetchSite("blog", "/api/hello", owner);
    expect(await api.json()).toEqual({ hello: "blog.sites.localhost" });
  });

  test("a signed-out browser goes to sign in, and comes back in with its pass", async () => {
    const signedOut = await sites.fetchSite("blog", "/");
    expect(signedOut.status).toBe(303);
    const location = new URL(signedOut.headers.get("location") ?? "");
    expect(location.origin).toBe("http://localhost:3002");
    const nonce = location.searchParams.get("nonce") ?? "";

    const token = pass("usr_owner", nonce);
    const back = await sites.fetchSite(
      "blog",
      `/__winston/enter?pass=${token}&path=/`,
      `winston_site_nonce=${nonce}`,
    );
    expect(back.status).toBe(303);
    expect(back.headers.getSetCookie()[0]).toStartWith(
      `winston_site_pass=${token};`,
    );
  });

  test("someone else's pass gets the private page", async () => {
    const response = await sites.fetchSite(
      "blog",
      "/",
      `winston_site_pass=${pass("usr_other")}`,
    );
    expect(response.status).toBe(403);
  });

  test("a share link opens the site for anyone, until it's unshared", async () => {
    const key = generateToken();
    await host.setRoute("blog", {
      ...route,
      access: "link",
      shareKeyHash: hashToken(key),
    });
    const opened = await sites.fetchSite("blog", `/__winston/share?key=${key}`);
    expect(opened.status).toBe(303);
    const cookie = opened.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    expect(cookie).toBe(`winston_site_share=${key}`);
    expect(await (await sites.fetchSite("blog", "/", cookie)).text()).toContain(
      "<h1>Hello</h1>",
    );
    await host.setRoute("blog", route);
    expect((await sites.fetchSite("blog", "/", cookie)).status).toBe(303);
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
    expect(await (await sites.fetchSite("blog", "/", owner)).text()).toBe("v2");
  });

  test("unknown and paused names get their pages", async () => {
    expect((await sites.fetchSite("nothing")).status).toBe(404);
    await host.setRoute("blog", { ...route, paused: true });
    expect((await sites.fetchSite("blog", "/", owner)).status).toBe(503);
    await host.setRoute("blog", route);
  });

  test("a deleted Worker or route leaves no site", async () => {
    await host.deleteScript(route.script);
    expect((await sites.fetchSite("blog", "/", owner)).status).toBe(404);
    await host.setRoute("blog", null);
    expect((await sites.fetchSite("blog", "/", owner)).status).toBe(404);
    // Deleting again is fine.
    await host.deleteScript(route.script);
  });

  test("a site's Worker reads the database its migrations made", async () => {
    const databaseId = await host.createDatabase("site_01db");
    const applied = await applyMigrations(host, databaseId, [
      {
        name: "0002_seed.sql",
        sql: "INSERT INTO notes (body) VALUES ('first;\nnote');",
      },
      {
        name: "0001_notes.sql",
        sql: "CREATE TABLE notes (\n  id INTEGER PRIMARY KEY,\n  body TEXT NOT NULL\n);",
      },
    ]);
    expect(applied).toEqual(["0001_notes.sql", "0002_seed.sql"]);
    // Applied ones are recorded, so running them again does nothing.
    expect(
      await applyMigrations(host, databaseId, [
        { name: "0001_notes.sql", sql: "CREATE TABLE notes (id INTEGER)" },
      ]),
    ).toEqual([]);

    await host.putScript("site_01db", {
      modules: [
        {
          name: "worker.js",
          content: `export default {
            async fetch(request, env) {
              const { results } = await env.DB.prepare("SELECT body FROM notes").all();
              return Response.json(results);
            },
          };`,
        },
      ],
      assets: [],
      databaseId,
    });
    await host.setRoute("notes", { ...route, script: "site_01db" });
    const notes = await sites.fetchSite(
      "notes",
      "/",
      `winston_site_pass=${signSitePass({ sub: "usr_owner", site: "notes", nonce: "n", exp: Date.now() + 60_000 }, signingKey)}`,
    );
    expect(await notes.json()).toEqual([{ body: "first;\nnote" }]);
  });

  test("a failing migration applies nothing of itself", async () => {
    const databaseId = await host.createDatabase("site_01bad");
    const failing = applyMigrations(host, databaseId, [
      {
        name: "0001_half.sql",
        sql: "CREATE TABLE ok (id INTEGER); CREATE TABLE ok (id INTEGER);",
      },
    ]);
    expect(failing).rejects.toThrow(MigrationError);
    await failing.catch(() => undefined);
    const [tables = []] = await host.batchSql(databaseId, [
      { sql: "SELECT name FROM sqlite_master WHERE name = 'ok'" },
    ]);
    expect(tables).toEqual([]);
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
