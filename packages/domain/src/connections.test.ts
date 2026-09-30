import { describe, expect, test } from "bun:test";
import { aliasPattern, defaultAlias } from "./connections.ts";

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

describe("aliases", () => {
  test("are shell-safe words", () => {
    for (const ok of ["work", "personal", "ada.l", "side_gig", "acme-2"])
      expect(aliasPattern.test(ok)).toBe(true);
    for (const bad of [
      "",
      "Work",
      "my work",
      "-x",
      "a;rm",
      "$(x)",
      "x".repeat(33),
    ])
      expect(aliasPattern.test(bad)).toBe(false);
  });

  test("default ones are always valid", () => {
    expect(defaultAlias("Ada+news@gmail.com", new Set(["personal"]))).toBe(
      "ada",
    );
    expect(defaultAlias("x@-weird.example", new Set(["work"]))).toBe("weird");
  });
});
