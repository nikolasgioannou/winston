import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBlobStore } from "@winston/blobs";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { localSiteHost } from "@winston/site-host/local-host";
import {
  signSitePass,
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";
import { setupApi } from "@winston/vm-api/testing";
import { startLocalSites } from "./server.ts";

const db = await testDb();
const signingKey = sitePassSigningKey(randomBytes(32).toString("hex"));

/**
 * `winston site deploy` from the backend's side, against the real local site
 * host: the VM-facing API reads the bundle, migrates its database, uploads
 * it, and the owner opens it through the dispatch Worker.
 */
describe("deploying to the local site host", () => {
  let dir: string;
  let sites: Awaited<ReturnType<typeof startLocalSites>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "winston-deploy-"));
    sites = await startLocalSites({
      dir,
      domain: "sites.localhost",
      port: 0,
      adminPort: 0,
      webUrl: "http://localhost:3002",
      passPublicKey: sitePassPublicKey(signingKey),
    });
  });

  afterAll(async () => {
    await sites.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a site with static files, an API and a database deploys and opens for its owner", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const bundle = await new Bun.Archive({
        "public/index.html": "<h1>Notes</h1>",
        "worker.js": `export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            if (url.pathname === "/api/notes") {
              const { results } = await env.DB.prepare("SELECT body FROM notes").all();
              return Response.json(results);
            }
            return env.ASSETS.fetch(request);
          },
        };`,
        "migrations/0001_notes.sql":
          "CREATE TABLE notes (\n  body TEXT NOT NULL\n);\nINSERT INTO notes VALUES ('hello');",
      }).bytes();
      const { as } = setupApi(
        tx,
        { "/home/winston/.cache/notes.tar": bundle },
        {
          sites: {
            host: localSiteHost(sites.adminUrl),
            blobs: localBlobStore(join(dir, "blobs")),
            sitesUrl: sites.url,
          },
        },
      );
      const response = await as(user.id)("/v1/sites/deploy", {
        method: "POST",
        body: { path: "/home/winston/.cache/notes.tar", name: "notes" },
      });
      expect(response.status).toBe(200);

      const owner = `winston_site_pass=${signSitePass(
        { sub: user.id, site: "notes", nonce: "n", exp: Date.now() + 60_000 },
        signingKey,
      )}`;
      expect(await (await sites.fetchSite("notes", "/", owner)).text()).toBe(
        "<h1>Notes</h1>",
      );
      expect(
        await (await sites.fetchSite("notes", "/api/notes", owner)).json(),
      ).toEqual([{ body: "hello" }]);
      // Anyone else is sent to sign in.
      expect((await sites.fetchSite("notes")).status).toBe(303);
    });
  });
});
