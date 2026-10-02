import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatSnapshot, type AxFrame, type RefTarget } from "./snapshot.ts";

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

/** Numbers refs in order, as a window's first snapshot does. */
const counting = () => {
  let next = 1;
  return () => `e${String(next++)}`;
};

describe("snapshots", () => {
  for (const page of ["form", "results", "modal", "frame"])
    test(`${page}: matches its golden file, by default and with --full`, async () => {
      const frame = await tree(page);
      for (const full of [false, true]) {
        const { lines } = formatSnapshot(frame, {
          full,
          refs: true,
          refFor: counting(),
        });
        expect(lines.join("\n")).toBe(
          await golden(full ? `${page}.full` : page),
        );
      }
    });

  test("refs point at nodes in the frame that holds them, cross-site frames included", async () => {
    const { refs } = formatSnapshot(await tree("frame"), {
      full: false,
      refs: true,
      refFor: counting(),
    });
    expect([...refs.entries()].map(([ref, t]) => [ref, t.sessionId])).toEqual([
      ["e1", "main"],
      ["e2", "main"],
      ["e3", "main-frame2"],
      ["e4", "main-frame2"],
      ["e5", "main"],
    ]);
  });

  test("a node keeps its ref across snapshots; a peek gives none", async () => {
    const seen = new Map<string, string>();
    let next = 1;
    const stable = (target: RefTarget) => {
      const key = `${target.sessionId}:${String(target.backendNodeId)}`;
      const ref = seen.get(key) ?? `e${String(next++)}`;
      seen.set(key, ref);
      return ref;
    };
    const frame = await tree("form");
    const first = formatSnapshot(frame, {
      full: false,
      refs: true,
      refFor: stable,
    });
    // The page changes: the first textbox goes away.
    const changed: AxFrame = {
      ...frame,
      nodes: frame.nodes.filter((node) => node.backendDOMNodeId !== 3),
    };
    const second = formatSnapshot(changed, {
      full: false,
      refs: true,
      refFor: stable,
    });
    expect(first.refs.get("e8")).toEqual(second.refs.get("e8"));
    expect(second.refs.has("e1")).toBe(false);
    const peek = formatSnapshot(frame, {
      full: false,
      refs: false,
      refFor: stable,
    });
    expect(peek.refs.size).toBe(0);
    expect(peek.lines.some((line) => /\[e\d+\]/.test(line))).toBe(false);
  });
});
