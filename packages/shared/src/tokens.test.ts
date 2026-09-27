import { describe, expect, test } from "bun:test";
import { generateToken, hashToken, tokenMatches } from "./tokens.ts";

describe("tokens", () => {
  test("tokens are random and URL-safe", () => {
    const [a, b] = [generateToken(), generateToken()];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]{43}$/);
  });

  test("a token matches its hash and nothing else", () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).not.toContain(token);
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(generateToken(), hash)).toBe(false);
    expect(tokenMatches(token, "not-a-hash")).toBe(false);
  });
});
