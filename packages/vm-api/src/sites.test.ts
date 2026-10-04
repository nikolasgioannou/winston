import { describe, expect, test } from "bun:test";
import { localBlobStore } from "@winston/blobs";
import { sites as sitesTable, siteVersions } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import type { SiteHost, SiteScript } from "@winston/site-host/host";
import type { SiteRoute } from "@winston/site-host/route";
import { hashToken } from "@winston/shared/tokens";
import { asc, eq } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxSitesPerUser } from "./sites.ts";
import { setupApi } from "./testing.ts";

const db = await testDb();

type Json = Record<string, unknown>;

/** A site host that remembers what it was asked to do, with databases that record their SQL. */
function fakeHost() {
  const scripts = new Map<string, SiteScript>();
  const routes = new Map<string, SiteRoute>();
  const databases = new Map<string, string[]>();
  const host: SiteHost = {
    kind: "local",
    putScript: (script, upload) => {
      scripts.set(script, upload);
      return Promise.resolve();
    },
    deleteScript: (script) => {
      scripts.delete(script);
      return Promise.resolve();
    },
    setRoute: (name, route) => {
      if (route) routes.set(name, route);
      else routes.delete(name);
      return Promise.resolve();
    },
    usage: () => Promise.resolve({ requests: 0, cpuMs: 0 }),
    databaseSize: () => Promise.resolve(0),
    deleteDatabase: (databaseId) => {
      databases.delete(databaseId);
      return Promise.resolve();
    },
    createDatabase: () => {
      const id = `db-${String(databases.size + 1)}`;
      databases.set(id, []);
      return Promise.resolve(id);
    },
    // Each database is the names of the migrations recorded in it.
    batchSql: (databaseId, statements) => {
      const applied = databases.get(databaseId) ?? [];
      if (statements.some(({ sql }) => sql.includes("FAIL")))
        return Promise.reject(new Error("syntax error"));
      return Promise.resolve(
        statements.map(({ sql, params }) => {
          if (sql.startsWith("INSERT INTO _winston_migrations"))
            applied.push(String(params?.[0]));
          return sql.startsWith("SELECT name")
            ? applied.map((name) => ({ name }))
            : [];
        }),
      );
    },
  };
  return { host, scripts, routes, databases };
}

async function setup(
  tx: Parameters<Parameters<typeof inRollback>[1]>[0],
  files: Record<string, Record<string, string>>,
) {
  const fake = fakeHost();
  const bundles = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(
        async ([path, contents]) =>
          [path, await new Bun.Archive(contents).bytes()] as const,
      ),
    ),
  );
  const blobs = localBlobStore(
    await mkdtemp(join(tmpdir(), "winston-site-blobs-")),
  );
  const api = setupApi(tx, bundles, {
    sites: { host: fake.host, blobs, sitesUrl: "https://runwinston.app" },
  });
  return { ...api, ...fake, blobs };
}

const deploy = (
  call: ReturnType<ReturnType<typeof setupApi>["as"]>,
  path: string,
  name: string,
) => call("/v1/sites/deploy", { method: "POST", body: { path, name } });

describe("site routes", () => {
  test("a first deploy claims the name, uploads the site privately and keeps version 1", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as, scripts, routes, blobs } = await setup(tx, {
        "/home/winston/.cache/blog.tar": {
          "public/index.html": "<h1>Hi</h1>",
        },
      });
      const response = await deploy(
        as(user.id),
        "/home/winston/.cache/blog.tar",
        "blog",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        site: Json;
        migrated: string[];
      };
      expect(body.site).toMatchObject({
        name: "blog",
        url: "https://blog.runwinston.app",
        access: "private",
        version: 1,
        database: false,
      });
      const id = String(body.site.id);
      expect(id).toStartWith("site_");
      expect(scripts.get(id)?.assets.map((a) => a.path)).toEqual([
        "/index.html",
      ]);
      expect(routes.get("blog")).toEqual({
        script: id,
        ownerId: user.id,
        access: "private",
        shareKeyHash: null,
        paused: false,
      });
      const [version] = await tx
        .select()
        .from(siteVersions)
        .where(eq(siteVersions.siteId, id));
      expect(version?.number).toBe(1);
      // The bundle is kept for rollback.
      expect((await blobs.get(version?.bundleKey ?? "")).byteLength).toBe(
        version?.size ?? -1,
      );
    });
  });

  test("migrations create the database once and apply only new ones; redeploys are new versions", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as, scripts, databases } = await setup(tx, {
        "/v1.tar": {
          "worker.js": "export default {}",
          "migrations/0001_notes.sql": "CREATE TABLE notes (id INTEGER);",
        },
        "/v2.tar": {
          "worker.js": "export default {}",
          "migrations/0001_notes.sql": "CREATE TABLE notes (id INTEGER);",
          "migrations/0002_tags.sql": "CREATE TABLE tags (id INTEGER);",
        },
      });
      const call = as(user.id);
      const first = (await (await deploy(call, "/v1.tar", "notes")).json()) as {
        site: Json;
        migrated: string[];
      };
      expect(first.migrated).toEqual(["0001_notes.sql"]);
      const second = (await (
        await deploy(call, "/v2.tar", "notes")
      ).json()) as { site: Json; migrated: string[] };
      expect(second.migrated).toEqual(["0002_tags.sql"]);
      expect(second.site).toMatchObject({ version: 2, database: true });
      expect([...databases.keys()]).toEqual(["db-1"]);
      expect(scripts.get(String(second.site.id))?.databaseId).toBe("db-1");
    });
  });

  test("a failing migration deploys nothing and says which one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as, scripts } = await setup(tx, {
        "/bad.tar": {
          "worker.js": "export default {}",
          "migrations/0001_bad.sql": "FAIL",
        },
      });
      const response = await deploy(as(user.id), "/bad.tar", "broken");
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(
        "0001_bad.sql failed",
      );
      expect(scripts.size).toBe(0);
    });
  });

  test("someone else's name, reserved and malformed names, and an 11th site are refused", async () => {
    await inRollback(db, async (tx) => {
      const owner = await insertUser(tx);
      const other = await insertUser(tx);
      const { as } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      expect((await deploy(as(owner.id), "/site.tar", "blog")).status).toBe(
        200,
      );
      const taken = await deploy(as(other.id), "/site.tar", "blog");
      expect(taken.status).toBe(409);
      expect(JSON.stringify(await taken.json())).toContain("is taken");
      expect((await deploy(as(other.id), "/site.tar", "www")).status).toBe(400);
      expect((await deploy(as(other.id), "/site.tar", "My Blog")).status).toBe(
        400,
      );

      for (let i = 1; i < maxSitesPerUser; i++)
        expect(
          (await deploy(as(owner.id), "/site.tar", `site-${String(i)}`)).status,
        ).toBe(200);
      const tooMany = await deploy(as(owner.id), "/site.tar", "one-more");
      expect(tooMany.status).toBe(409);
      // Redeploying an existing site is still fine.
      expect((await deploy(as(owner.id), "/site.tar", "blog")).status).toBe(
        200,
      );
    });
  });

  test("a bad bundle is refused before anything is claimed", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as } = await setup(tx, { "/stray.tar": { "notes.txt": "hi" } });
      const response = await deploy(as(user.id), "/stray.tar", "stray");
      expect(response.status).toBe(400);
      expect(
        await tx.select().from(sitesTable).where(eq(sitesTable.name, "stray")),
      ).toEqual([]);
      const missing = await deploy(as(user.id), "/missing.tar", "stray");
      expect(missing.status).toBe(400);
    });
  });

  test("list and show cover only the user's own sites", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const other = await insertUser(tx);
      const { as } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      await deploy(as(user.id), "/site.tar", "mine");
      await deploy(as(other.id), "/site.tar", "theirs");
      const listed = (await (await as(user.id)("/v1/sites")).json()) as {
        sites: Json[];
      };
      expect(listed.sites.map((site) => site.name)).toEqual(["mine"]);
      const shown = await as(user.id)("/v1/sites/mine");
      expect(((await shown.json()) as { site: Json }).site.name).toBe("mine");
      expect((await as(user.id)("/v1/sites/theirs")).status).toBe(404);
      const rows = await tx
        .select({ name: sitesTable.name })
        .from(sitesTable)
        .orderBy(asc(sitesTable.name));
      expect(rows.map((row) => row.name)).toEqual(["mine", "theirs"]);
    });
  });

  test("share gives a link whose key only the route's hash knows; again, the same link; unshare, then share, a new one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as, routes } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      const call = as(user.id);
      await deploy(call, "/site.tar", "blog");
      const share = async () =>
        (
          (await (
            await call("/v1/sites/blog/share", { method: "POST", body: {} })
          ).json()) as { site: { access: string; shareLink: string } }
        ).site;

      const first = await share();
      expect(first.access).toBe("link");
      const key = new URL(first.shareLink).searchParams.get("key") ?? "missing";
      expect(first.shareLink).toStartWith(
        "https://blog.runwinston.app/__winston/share?key=",
      );
      expect(routes.get("blog")).toMatchObject({
        access: "link",
        shareKeyHash: hashToken(key),
      });
      expect(JSON.stringify(routes.get("blog"))).not.toContain(key);
      expect((await share()).shareLink).toBe(first.shareLink);

      const unshared = (await (
        await call("/v1/sites/blog/unshare", { method: "POST", body: {} })
      ).json()) as { site: { access: string; shareLink: string | null } };
      expect(unshared.site).toMatchObject({
        access: "private",
        shareLink: null,
      });
      expect(routes.get("blog")).toMatchObject({
        access: "private",
        shareKeyHash: null,
      });
      expect((await share()).shareLink).not.toBe(first.shareLink);
    });
  });

  test("only the user's own deployed sites can be shared", async () => {
    await inRollback(db, async (tx) => {
      const owner = await insertUser(tx);
      const other = await insertUser(tx);
      const { as } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      await deploy(as(owner.id), "/site.tar", "blog");
      const theirs = await as(other.id)("/v1/sites/blog/share", {
        method: "POST",
        body: {},
      });
      expect(theirs.status).toBe(404);
      // A site whose first deploy failed has no version to share.
      await tx.insert(sitesTable).values({ userId: owner.id, name: "empty" });
      const empty = await as(owner.id)("/v1/sites/empty/share", {
        method: "POST",
        body: {},
      });
      expect(empty.status).toBe(409);
    });
  });

  test("rollback puts the previous (or a chosen) version's files back, and later deploys go on from the newest number", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const bundle = (n: number) => ({ "public/index.html": `v${String(n)}` });
      const { as, scripts } = await setup(tx, {
        "/v1.tar": bundle(1),
        "/v2.tar": bundle(2),
        "/v3.tar": bundle(3),
        "/v4.tar": bundle(4),
      });
      const call = as(user.id);
      for (const n of [1, 2, 3])
        await deploy(call, `/v${String(n)}.tar`, "blog");
      const served = async () => {
        const [site] = await tx
          .select()
          .from(sitesTable)
          .where(eq(sitesTable.name, "blog"));
        const html = scripts.get(site?.id ?? "")?.assets[0]?.content;
        return {
          version: site?.currentVersion,
          html: new TextDecoder().decode(html),
        };
      };

      const back = await call("/v1/sites/blog/rollback", {
        method: "POST",
        body: {},
      });
      expect(back.status).toBe(200);
      expect(JSON.stringify(await back.json())).toContain(
        "database stays as it is",
      );
      expect(await served()).toEqual({ version: 2, html: "v2" });

      await call("/v1/sites/blog/rollback", {
        method: "POST",
        body: { to: 1 },
      });
      expect(await served()).toEqual({ version: 1, html: "v1" });
      // Already there, a missing version, and nothing before the first.
      expect(
        (
          await call("/v1/sites/blog/rollback", {
            method: "POST",
            body: { to: 1 },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call("/v1/sites/blog/rollback", {
            method: "POST",
            body: { to: 9 },
          })
        ).status,
      ).toBe(404);
      expect(
        (await call("/v1/sites/blog/rollback", { method: "POST", body: {} }))
          .status,
      ).toBe(404);

      await deploy(call, "/v4.tar", "blog");
      expect(await served()).toEqual({ version: 4, html: "v4" });
      const versions = (await (
        await call("/v1/sites/blog/versions")
      ).json()) as {
        versions: { number: number; current: boolean }[];
      };
      expect(versions.versions.map((v) => [v.number, v.current])).toEqual([
        [4, true],
        [3, false],
        [2, false],
        [1, false],
      ]);
    });
  });

  test("only the newest 10 versions are kept, and bundles no version uses are deleted", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const files = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `/v${String(i + 1)}.tar`,
          { "public/index.html": `v${String(i + 1)}` },
        ]),
      );
      const { as, blobs } = await setup(tx, files);
      const call = as(user.id);
      await deploy(call, "/v1.tar", "blog");
      const [v1] = await tx
        .select({ bundleKey: siteVersions.bundleKey })
        .from(siteVersions);
      const firstKey = v1?.bundleKey ?? "missing";
      expect((await blobs.get(firstKey)).byteLength).toBeGreaterThan(0);
      for (let n = 2; n <= 12; n++)
        await deploy(call, `/v${String(n)}.tar`, "blog");
      const rows = await tx
        .select({
          number: siteVersions.number,
          bundleKey: siteVersions.bundleKey,
        })
        .from(siteVersions)
        .orderBy(asc(siteVersions.number));
      expect(rows.map((row) => row.number)).toEqual([
        3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(await blobs.get(firstKey).catch(() => "gone")).toBe("gone");
      expect(
        (await blobs.get(rows[0]?.bundleKey ?? "")).byteLength,
      ).toBeGreaterThan(0);
      expect(
        (
          await call("/v1/sites/blog/rollback", {
            method: "POST",
            body: { to: 2 },
          })
        ).status,
      ).toBe(404);
    });
  });

  test("delete takes a site down for good and frees its name; a dry run only says so", async () => {
    await inRollback(db, async (tx) => {
      const owner = await insertUser(tx);
      const other = await insertUser(tx);
      const { as, scripts, routes, databases, blobs } = await setup(tx, {
        "/notes.tar": {
          "worker.js": "export default {}",
          "migrations/0001.sql": "CREATE TABLE notes (id INTEGER);",
        },
      });
      await deploy(as(owner.id), "/notes.tar", "notes");
      const [version] = await tx.select().from(siteVersions);

      const preview = await as(owner.id)("/v1/sites/notes", {
        method: "DELETE",
        body: { dryRun: true },
      });
      expect(await preview.json()).toEqual({
        dryRun: true,
        summary: expect.stringContaining(
          "database (with all its data)",
        ) as string,
      });
      expect(routes.has("notes")).toBe(true);

      const deleted = await as(owner.id)("/v1/sites/notes", {
        method: "DELETE",
        body: {},
      });
      expect(await deleted.json()).toMatchObject({
        name: "notes",
        deleted: true,
      });
      expect(routes.has("notes")).toBe(false);
      expect(scripts.size).toBe(0);
      expect(databases.size).toBe(0);
      expect(await tx.select().from(sitesTable)).toEqual([]);
      expect(
        await blobs.get(version?.bundleKey ?? "").catch(() => "gone"),
      ).toBe("gone");
      // The name is free again, for anyone.
      expect((await deploy(as(other.id), "/notes.tar", "notes")).status).toBe(
        200,
      );
    });
  });

  test("dry runs check everything but change nothing", async () => {
    await inRollback(db, async (tx) => {
      const owner = await insertUser(tx);
      const other = await insertUser(tx);
      const { as, routes } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      const preview = await as(owner.id)("/v1/sites/deploy", {
        method: "POST",
        body: { path: "/site.tar", name: "blog", dryRun: true },
      });
      expect(((await preview.json()) as { summary: string }).summary).toContain(
        "Would claim https://blog.runwinston.app",
      );
      expect(await tx.select().from(sitesTable)).toEqual([]);

      await deploy(as(owner.id), "/site.tar", "blog");
      const taken = await as(other.id)("/v1/sites/deploy", {
        method: "POST",
        body: { path: "/site.tar", name: "blog", dryRun: true },
      });
      expect(taken.status).toBe(409);
      const share = await as(owner.id)("/v1/sites/blog/share", {
        method: "POST",
        body: { dryRun: true },
      });
      expect(((await share.json()) as { summary: string }).summary).toContain(
        "Would share blog by link",
      );
      expect(routes.get("blog")?.access).toBe("private");
    });
  });

  test("fetch needs a deployed site and a pass key", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const { as } = await setup(tx, {
        "/site.tar": { "public/index.html": "hi" },
      });
      await tx.insert(sitesTable).values({ userId: user.id, name: "empty" });
      const undeployed = await as(user.id)("/v1/sites/empty/fetch", {
        method: "POST",
        body: {},
      });
      expect(undeployed.status).toBe(409);
      await deploy(as(user.id), "/site.tar", "blog");
      // The test setup has no pass key, as where checking isn't set up.
      const unavailable = await as(user.id)("/v1/sites/blog/fetch", {
        method: "POST",
        body: { path: "/" },
      });
      expect(unavailable.status).toBe(503);
    });
  });
});
