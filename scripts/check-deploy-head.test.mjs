import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentIsCurrent } from "./check-deploy-head.mjs";

const input = { repository: "fixture/project", sha: "a".repeat(40), token: "fixture-read-token" };
const reference = (sha) => ({ ref: "refs/heads/main", object: { type: "commit", sha } });

test("only the current verified commit is eligible to deploy", async () => {
  const current = await deploymentIsCurrent(input, async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/fixture/project/git/ref/heads/main");
    assert.equal(options.headers.Authorization, "Bearer fixture-read-token");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(reference(input.sha));
  });
  assert.equal(current, true);
  assert.equal(
    await deploymentIsCurrent(input, async () => Response.json(reference("b".repeat(40)))),
    false,
  );
});

test("verification fails closed on unavailable or malformed GitHub responses", async () => {
  for (const response of [
    new Response(null, { status: 503 }),
    new Response("not-json"),
    Response.json(null),
    Response.json({ ...reference(input.sha), ref: "refs/heads/other" }),
    Response.json(reference("invalid")),
    Response.json({ ref: "refs/heads/main", object: { type: "tag", sha: input.sha } }),
  ]) {
    await assert.rejects(() => deploymentIsCurrent(input, async () => response));
  }
  await assert.rejects(
    () =>
      deploymentIsCurrent(input, async () => {
        throw new Error("transport unavailable");
      }),
    /Could not verify the current deployment revision/,
  );
});

test("invalid CI inputs never make an authenticated request", async () => {
  for (const change of [
    { repository: "fixture/project/../../other" },
    { repository: "https://elsewhere.invalid" },
    { sha: "main" },
    { token: "" },
  ]) {
    await assert.rejects(() =>
      deploymentIsCurrent({ ...input, ...change }, async () => {
        assert.fail("Invalid inputs must be rejected before contacting GitHub");
      }),
    );
  }
});
