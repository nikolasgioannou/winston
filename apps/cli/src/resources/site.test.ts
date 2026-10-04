import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";

const site = {
  id: "site_01abc",
  name: "blog",
  url: "https://blog.runwinston.app",
  access: "private",
  shareLink: null,
  paused: false,
  version: 1,
  database: true,
  createdAt: "2026-10-03T12:00:00.000Z",
  updatedAt: "2026-10-03T12:00:00.000Z",
};

const bytes = (text: string) => new TextEncoder().encode(text);

/** A site folder on the VM's disk. */
const disk = (files: Record<string, string>) =>
  new Map(
    Object.entries(files).map(([path, text]) => [
      `/home/winston/sites/blog/${path}`,
      bytes(text),
    ]),
  );

describe("winston site", () => {
  test("deploy packs public/, worker.js and migrations into a tar the backend reads, then removes it", async () => {
    const files = disk({
      "public/index.html": "<h1>Hi</h1>",
      "public/.DS_Store": "junk",
      "worker.js": "export default {}",
      "migrations/0001_notes.sql": "CREATE TABLE notes (id INTEGER);",
      "package.json": "{}",
      "node_modules/x/index.js": "x",
    });
    let packed: string[] = [];
    const { code, out, requests } = await cli(
      ["site", "deploy", "~/sites/blog"],
      async (request) => {
        const body = (await request.json()) as { path: string; name: string };
        expect(body.name).toBe("blog");
        expect(body.path).toStartWith(
          "/home/winston/.cache/winston/sites/blog-",
        );
        const tar = files.get(body.path);
        packed = [
          ...(await new Bun.Archive(tar ?? new Uint8Array()).files()).keys(),
        ].sort();
        return Response.json({ site, migrated: ["0001_notes.sql"] });
      },
      [],
      files,
    );
    expect(code).toBe(0);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/sites/deploy");
    expect(packed).toEqual([
      "migrations/0001_notes.sql",
      "public/index.html",
      "worker.js",
    ]);
    expect([...files.keys()].some((path) => path.endsWith(".tar"))).toBe(false);
    expect(out).toMatchInlineSnapshot(`
      "site_01abc · blog · https://blog.runwinston.app · private · version 1 · database
      Private: only the user can open it, signed in to Winston.
      Deployed 1 static file, worker.js, 1 migration.
      Applied migrations: 0001_notes.sql."
    `);
  });

  test("--name picks the address; the tar is removed even when the deploy fails", async () => {
    const files = disk({ "public/index.html": "hi" });
    const { code, err } = await cli(
      ["site", "deploy", "/home/winston/sites/blog", "--name", "lisbon-trip"],
      async (request) => {
        expect(((await request.json()) as { name: string }).name).toBe(
          "lisbon-trip",
        );
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "https://lisbon-trip.runwinston.app is taken.",
              hint: "Pick another name with --name.",
            },
          },
          { status: 409 },
        );
      },
      [],
      files,
    );
    expect(code).toBe(6);
    expect(err).toContain("is taken");
    expect([...files.keys()].some((path) => path.endsWith(".tar"))).toBe(false);
  });

  test("a folder with nothing to deploy, or outside the home, is a usage error", async () => {
    const unreachable = () => {
      throw new Error("no request expected");
    };
    const empty = await cli(
      ["site", "deploy", "~/sites/blog"],
      unreachable,
      [],
      disk({ "notes.md": "hi" }),
    );
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("nothing to deploy");
    const outside = await cli(["site", "deploy", "/etc"], unreachable);
    expect(outside.code).toBe(1);
    expect(outside.err).toContain("outside /home/winston");
  });

  test("list and get show one line per site", async () => {
    const listed = await cli(["site", "list"], () =>
      Response.json({
        sites: [
          site,
          {
            ...site,
            id: "site_02",
            name: "notes",
            version: null,
            database: false,
          },
        ],
      }),
    );
    expect(listed.out).toMatchInlineSnapshot(`
      "site_01abc · blog · https://blog.runwinston.app · private · version 1 · database
      site_02 · notes · https://blog.runwinston.app · private · not deployed"
    `);
    const shown = await cli(["site", "get", "blog"], (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sites/blog");
      return Response.json({ site: { ...site, paused: true } });
    });
    expect(shown.out).toBe(
      "site_01abc · blog · https://blog.runwinston.app · paused · version 1 · database\nPrivate: only the user can open it, signed in to Winston.",
    );
  });

  test("share prints the link anyone can open; unshare says it's private again", async () => {
    const link = "https://blog.runwinston.app/__winston/share?key=k3y";
    const shared = await cli(["site", "share", "blog"], (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/v1/sites/blog/share");
      return Response.json({
        site: { ...site, access: "link", shareLink: link },
      });
    });
    expect(shared.out).toBe(
      `site_01abc · blog · https://blog.runwinston.app · shared by link · version 1 · database\nAnyone with this link can open it: ${link}`,
    );
    const unshared = await cli(["site", "unshare", "blog"], (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/sites/blog/unshare");
      return Response.json({ site });
    });
    expect(unshared.out).toContain("Private: only the user can open it");
    const missing = await cli(["site", "share"], () => Response.json({}));
    expect(missing.code).toBe(1);
  });

  test("versions lists deploys; rollback says the database stays as it is", async () => {
    const versions = await cli(["site", "versions", "blog"], () =>
      Response.json({
        site,
        versions: [
          {
            number: 2,
            size: 2048,
            current: true,
            deployedAt: "2026-10-04T05:00:00.000Z",
          },
          {
            number: 1,
            size: 1024,
            current: false,
            deployedAt: "2026-10-03T05:00:00.000Z",
          },
        ],
      }),
    );
    expect(versions.out).toMatchInlineSnapshot(`
      "version 2 · 2026-10-04T05:00:00.000Z · 2 KB · current
      version 1 · 2026-10-03T05:00:00.000Z · 1 KB"
    `);
    const rolledBack = await cli(
      ["site", "rollback", "blog", "--to", "1"],
      async (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/sites/blog/rollback");
        expect(await request.json()).toEqual({ to: 1, dryRun: false });
        return Response.json({
          site,
          note: "The database stays as it is: rollback restores the code and files, not data or migrations.",
        });
      },
    );
    expect(rolledBack.out).toContain("The database stays as it is");
  });

  test("--dry-run sends dryRun and prints what would happen; delete says the name is free", async () => {
    const preview = await cli(
      ["site", "delete", "blog", "--dry-run"],
      async (request) => {
        expect(request.method).toBe("DELETE");
        expect(await request.json()).toEqual({ dryRun: true });
        return Response.json({
          dryRun: true,
          summary: "Would take blog down for good.",
        });
      },
    );
    expect(preview.out).toBe("Would take blog down for good.");
    const deleted = await cli(["site", "delete", "blog"], () =>
      Response.json({ id: "site_01abc", name: "blog", deleted: true }),
    );
    expect(deleted.out).toBe(
      "Took blog down. Its address no longer answers, and the name is free.",
    );
    const share = await cli(["site", "share", "blog", "--dry-run"], () =>
      Response.json({ dryRun: true, summary: "Would share blog by link." }),
    );
    expect(share.out).toBe("Would share blog by link.");
  });

  test("fetch prints the status and the body; --data posts JSON", async () => {
    const page = await cli(["site", "fetch", "notes"], async (request) => {
      expect(await request.json()).toEqual({ path: "/", method: "GET" });
      return Response.json({
        status: 200,
        contentType: "text/html",
        location: null,
        size: 15,
        body: "<h1>Notes</h1>",
        truncated: false,
      });
    });
    expect(page.out).toBe("200 · text/html · 15 bytes\n<h1>Notes</h1>");
    const posted = await cli(
      ["site", "fetch", "notes", "api/notes", "--data", '{"body":"hi"}'],
      async (request) => {
        expect(await request.json()).toEqual({
          path: "/api/notes",
          method: "POST",
          body: '{"body":"hi"}',
          contentType: "application/json",
        });
        return Response.json({
          status: 201,
          contentType: "application/json",
          location: null,
          size: 9,
          body: '{"id":3}',
          truncated: false,
        });
      },
    );
    expect(posted.out).toContain("201 · application/json");
    const wrong = await cli(
      ["site", "fetch", "notes", "--method", "TRACE"],
      () => Response.json({}),
    );
    expect(wrong.code).toBe(1);
  });
});
