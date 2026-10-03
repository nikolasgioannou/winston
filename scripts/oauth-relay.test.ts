import { describe, expect, test } from "bun:test";
import { relay, returnCookieName } from "./oauth-relay";

const callback =
  "http://localhost:3003/auth/google/callback?code=abc&state=xyz";
const withOrigin = (origin: string, url = callback) =>
  new Request(url, {
    headers: {
      cookie: `other=1; ${returnCookieName}=${encodeURIComponent(origin)}`,
    },
  });

describe("relay", () => {
  test("sends Google's callback on to the worktree's site", () => {
    const response = relay(withOrigin("http://localhost:3012"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3012/auth/google/callback?code=abc&state=xyz",
    );
  });

  test("relays the connect callback too", () => {
    const response = relay(
      withOrigin(
        "http://localhost:3022",
        "http://localhost:3003/auth/google/connect/callback?code=abc",
      ),
    );
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3022/auth/google/connect/callback?code=abc",
    );
  });

  test("refuses without the cookie", () => {
    expect(relay(new Request(callback)).status).toBe(400);
  });

  test.each([
    "https://evil.example",
    "http://localhost.evil.example:3012",
    "http://localhost:3012/path",
    "http://127.0.0.1:3012",
  ])("refuses to send the browser to %s", (origin) => {
    expect(relay(withOrigin(origin)).status).toBe(400);
  });

  test("relays only Google's callbacks", () => {
    expect(
      relay(withOrigin("http://localhost:3012", "http://localhost:3003/other"))
        .status,
    ).toBe(400);
  });
});
