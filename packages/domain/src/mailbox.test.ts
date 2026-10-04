import { describe, expect, test } from "bun:test";
import {
  mailboxAddress,
  mailboxNameProblem,
  normalizeMailboxName,
} from "./mailbox.ts";

describe("mailbox names", () => {
  test("letters, digits, dots and hyphens, 3 to 30 characters", () => {
    for (const name of ["nik", "ada.lovelace", "ada-l", "a1b", "x".repeat(30)])
      expect(mailboxNameProblem(name)).toBeUndefined();
    expect(mailboxNameProblem("ab")).toBe("too_short");
    expect(mailboxNameProblem("x".repeat(31))).toBe("too_long");
    for (const name of ["ada_l", "ada+l", "ädä", "ada l", "Ada"])
      expect(mailboxNameProblem(name)).toBe("invalid_characters");
  });

  test("starts and ends with a letter or digit, with no doubled punctuation", () => {
    for (const name of [".ada", "ada.", "-ada", "ada-", "ada..l", "ada.-l"])
      expect(mailboxNameProblem(name)).toBe("bad_punctuation");
  });

  test("role and lookalike names are reserved", () => {
    for (const name of ["postmaster", "abuse", "noreply", "support", "winston"])
      expect(mailboxNameProblem(name)).toBe("reserved");
  });

  test("names are compared trimmed and lowercase", () => {
    expect(normalizeMailboxName("  Ada.L ")).toBe("ada.l");
    expect(mailboxAddress("ada")).toBe("ada@runwinston.email");
  });
});
