import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatSnapshot, type AxFrame } from "./snapshot.ts";

/**
 * The fixtures are Chrome's own accessibility trees for the pages beside
 * them (`*.html`), recorded from the VM's Chrome; the `.txt` files are the
 * snapshots they should give.
 */
const fixtures = join(import.meta.dir, "fixtures");
const tree = async (page: string) =>
  (await Bun.file(join(fixtures, `${page}.ax.json`)).json()) as AxFrame;
const golden = async (name: string) =>
  (await Bun.file(join(fixtures, `${name}.txt`)).text()).trimEnd();

describe("snapshots", () => {
  for (const page of ["form", "results", "modal", "frame"])
    test(`${page}: matches its golden file, by default and with --full`, async () => {
      const frame = await tree(page);
      for (const full of [false, true]) {
        const lines = formatSnapshot(frame, { full });
        expect(lines.join("\n")).toBe(
          await golden(full ? `${page}.full` : page),
        );
      }
    });

  test("it's for reading: no line carries a ref to act on", async () => {
    for (const page of ["form", "results", "modal", "frame"]) {
      const lines = formatSnapshot(await tree(page), { full: false });
      expect(lines.some((line) => /\[e\d+\]/.test(line))).toBe(false);
    }
  });
});
