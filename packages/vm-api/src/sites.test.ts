import { describe, expect, test } from "bun:test";
import { localBlobStore } from "@winston/blobs";
import { sites as sitesTable, siteVersions } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import type { SiteHost, SiteScript } from "@winston/site-host/host";
import type { SiteRoute } from "@winston/site-host/route";
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
});
