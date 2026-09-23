import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import type { Artifact } from "@winston/contracts/artifacts";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createArtifactOwnerRouter } from "../src/http/artifacts";
import { readStorageConfig } from "../src/storage-config";

test("artifact downloads require owner sessions and deletion requires the owner origin", async () => {
  const ownerId = randomUUID();
  const id = randomUUID();
  const artifact: Artifact = {
    id,
    state: "ready",
    revision: 1,
    metadata: {
      name: "fixture.txt",
      mediaType: "text/plain",
      size: 1,
      sha256: "a".repeat(64),
      source: { kind: "workspace", reference: "fixture" },
    },
    object: { id, ownerId, purpose: "artifact", size: 1, sha256: "a".repeat(64) },
  };
  let links = 0;
  let deletes = 0;
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "owner-session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/artifacts",
          createArtifactOwnerRouter({
            list(owner) {
              assert.equal(owner, ownerId);
              return Promise.resolve([artifact]);
            },
            download(owner, requestedId) {
              assert.equal(owner, ownerId);
              assert.equal(requestedId, id);
              links++;
              return Promise.resolve({
                url: "https://storage.invalid/signed",
                expiresIn: 60,
                name: "fixture.txt",
              });
            },
            remove(owner) {
              assert.equal(owner, ownerId);
              deletes++;
              return Promise.resolve({ ...artifact, state: "deleted" });
            },
          }),
        ),
      },
    },
  });
  const path = `/api/owner/artifacts/${id}/download`;
  assert.equal((await app.request(path)).status, 401);
  assert.equal(
    (await app.request(path, { headers: { Authorization: "Bearer worker-token" } })).status,
    401,
  );
  assert.equal(links, 0);
  const headers = { Cookie: "owner-session" };
  const downloaded = await app.request(path, { headers });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("Cache-Control"), "no-store");
  assert.equal(links, 1);
  const list = await app.request("/api/owner/artifacts", { headers });
  const listText = await list.text();
  assert.ok(!listText.includes(ownerId));
  assert.ok(!listText.includes('"object"'));
  assert.equal((await app.request("/api/owner/artifacts?after=invalid", { headers })).status, 400);
  assert.equal(
    (await app.request(`/api/owner/artifacts/${id}`, { method: "DELETE", headers })).status,
    403,
  );
  assert.equal(deletes, 0);
  assert.equal(
    (
      await app.request(`/api/owner/artifacts/${id}`, {
        method: "DELETE",
        headers: { ...headers, Origin: "https://web.example" },
      })
    ).status,
    200,
  );
  assert.equal(deletes, 1);
});

test("storage configuration stays optional and rejects partial credentials without disclosing values", () => {
  assert.equal(readStorageConfig({ AWS_REGION: "auto" }), null);
  assert.throws(
    () => readStorageConfig({ AWS_ACCESS_KEY_ID: "secret-value" }),
    /configuration is incomplete/,
  );
  const environment = {
    AWS_ACCESS_KEY_ID: "synthetic",
    AWS_SECRET_ACCESS_KEY: "synthetic",
    AWS_ENDPOINT_URL_S3: "https://storage.invalid",
    BUCKET_NAME: "fixture",
  };
  assert.equal(readStorageConfig(environment)?.region, "auto");
  assert.throws(() =>
    readStorageConfig({ ...environment, AWS_ENDPOINT_URL_S3: "http://storage.invalid" }),
  );
});
