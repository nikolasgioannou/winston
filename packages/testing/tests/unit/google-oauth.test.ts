import assert from "node:assert/strict";
import { test } from "bun:test";
import { createGoogleOAuth } from "@winston/adapters/google";
import { googleScopes } from "@winston/contracts/connections";

test("Google connector consent isolates service scopes and binds state, PKCE and nonce", () => {
  const oauth = createGoogleOAuth({
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    redirectUri: "http://127.0.0.1:3001/callbacks/google/connections",
  });
  const url = new URL(oauth.url("gmail", "fixture-state"));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(url.searchParams.get("state"), "fixture-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope")?.includes(googleScopes.gmail[0]));
  assert.ok(!url.searchParams.get("scope")?.includes("calendar"));
  const another = new URL(oauth.url("gmail", "another-state"));
  assert.notEqual(url.searchParams.get("nonce"), another.searchParams.get("nonce"));
  assert.notEqual(
    url.searchParams.get("code_challenge"),
    another.searchParams.get("code_challenge"),
  );
  assert.ok(!url.href.includes("fixture-secret"));
});
