import { describe, expect, test } from "bun:test";
import { defaultAlias } from "./connections.ts";

describe("defaultAlias", () => {
  test("personal for Gmail, work for anything else", () => {
    expect(defaultAlias("ada@gmail.com", new Set())).toBe("personal");
    expect(defaultAlias("Ada@Acme.co.uk", new Set())).toBe("work");
  });

  test("falls back to the company or the address's name, then numbers", () => {
    expect(defaultAlias("ada@acme.com", new Set(["work"]))).toBe("acme");
    expect(defaultAlias("ada.l@gmail.com", new Set(["personal"]))).toBe(
      "ada.l",
    );
    expect(defaultAlias("ada@acme.com", new Set(["work", "acme"]))).toBe(
      "work-2",
    );
  });
});
