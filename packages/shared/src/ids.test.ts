import { describe, expect, test } from "bun:test";
import { createId, parseId, type Id } from "./ids.ts";

describe("createId", () => {
  test("produces the prefix followed by a 26-character suffix", () => {
    expect(createId("usr")).toMatch(/^usr_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  });

  test("ids created later sort after earlier ones", () => {
    const ids = Array.from({ length: 50 }, () => createId("usr"));
    expect([...ids].sort()).toEqual(ids);
  });

  test("rejects prefixes outside lowercase letters and underscores", () => {
    expect(() => createId("User")).toThrow();
    expect(() => createId("has space")).toThrow();
  });
});

describe("parseId", () => {
  test("accepts a valid id with the expected prefix", () => {
    const id = createId("usr");
    expect(parseId(id, "usr")).toBe(id);
  });

  test("rejects a different prefix, malformed suffixes and uppercase", () => {
    const id = createId("usr");
    expect(parseId(id, "run")).toBeUndefined();
    expect(parseId("usr_short", "usr")).toBeUndefined();
    expect(parseId("usr_8zzzzzzzzzzzzzzzzzzzzzzzzz", "usr")).toBeUndefined();
    expect(parseId(id.toUpperCase(), "usr")).toBeUndefined();
  });

  test("ids of different entities can't be mixed up", () => {
    const takesRun = (id: Id<"run">) => id;
    // @ts-expect-error an Id<"usr"> is not an Id<"run">
    takesRun(createId("usr"));
    // @ts-expect-error a plain string is not an id
    takesRun("run_01h2xcejqtf2nbrexx3vqjhp41");
    expect(takesRun(createId("run"))).toStartWith("run_");
  });
});
