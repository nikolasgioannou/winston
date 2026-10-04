import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";

const site = {
  id: "site_01abc",
  name: "blog",
  url: "https://blog.runwinston.app",
  access: "private",
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
      Deployed 1 static file, worker.js, 1 migration.
      Applied migrations: 0001_notes.sql.
      Private: only the user can open it, signed in to Winston."
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
      "site_01abc · blog · https://blog.runwinston.app · paused · version 1 · database",
    );
  });
});
