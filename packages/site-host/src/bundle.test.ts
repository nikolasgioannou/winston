import { describe, expect, test } from "bun:test";
import { BundleError, maxBundleBytes, readBundle } from "./bundle.ts";

const tar = (files: Record<string, string>) => new Bun.Archive(files).bytes();

describe("site bundles", () => {
  test("public files are assets, worker.js the entry module, migrations by name", async () => {
    const { script, migrations } = await readBundle(
      await tar({
        "public/index.html": "<h1>Hi</h1>",
        "public/css/site.css": "body {}",
        "worker.js": "export default {}",
        "migrations/0001_notes.sql": "CREATE TABLE notes (id INTEGER)",
      }),
    );
    expect(script.modules).toEqual([
      { name: "worker.js", content: "export default {}" },
    ]);
    expect(script.assets.map((asset) => asset.path).sort()).toEqual([
      "/css/site.css",
      "/index.html",
    ]);
    expect(migrations).toEqual([
      { name: "0001_notes.sql", sql: "CREATE TABLE notes (id INTEGER)" },
    ]);
  });

  test("a site without worker.js gets one that serves its files", async () => {
    const { script } = await readBundle(
      await tar({ "public/index.html": "<h1>Hi</h1>" }),
    );
    expect(script.modules[0]?.content).toContain("env.ASSETS.fetch");
  });

  test("empty bundles, stray files, unsafe paths and oversized bundles are refused", async () => {
    const refusal = async (bytes: Uint8Array) => {
      const error = await readBundle(bytes).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BundleError);
      return String(error);
    };
    expect(await refusal(await tar({}))).toMatch(/nothing to deploy/);
    expect(
      await refusal(await tar({ "worker.js": "x", "README.md": "hi" })),
    ).toMatch(/README\.md/);
    await refusal(await tar({ "public/../x": "x" }));
    expect(await refusal(new Uint8Array(maxBundleBytes + 1))).toMatch(
      /the most is 25\.0 MB/,
    );
    await refusal(new Uint8Array([1, 2, 3]));
  });
});
