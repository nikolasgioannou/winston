import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import { verifyTelegramWebhook, type TelegramStore } from "@winston/adapters/telegram";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createTelegramCallbackRouter, createTelegramOwnerRouter } from "../src/http/telegram";

test("Telegram callbacks reject forged secrets and owner pairing mutations require an authenticated origin", async () => {
  let received = 0;
  let challenges = 0;
  const acknowledgments: string[] = [];
  const store: TelegramStore = {
    close: () => Promise.resolve(),
    challenge: () => {
      challenges += 1;
      return Promise.resolve({
        id: "11111111-1111-4111-8111-111111111111",
        secret: "safe-fixture",
      });
    },
    status: () => Promise.resolve({ binding: null, challenge: null }),
    confirm: () => Promise.resolve(false),
    unpair: () => Promise.resolve(),
    receive: () => {
      received += 1;
      return Promise.resolve("accepted");
    },
  };
  const secret = "fixture-secret";
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      callback: {
        router: createTelegramCallbackRouter(store, (id, text) => {
          acknowledgments.push(`${id}: ${text}`);
          return Promise.reject(new Error("Expired callback"));
        }),
        authenticate: (request) =>
          Promise.resolve(
            verifyTelegramWebhook(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), secret)
              ? { kind: "callback", provider: "telegram" }
              : null,
          ),
      },
      owner: {
        router: new Hono<HttpEnvironment>().route(
          "/telegram",
          createTelegramOwnerRouter(store, "example_bot"),
        ),
        authenticate: () =>
          Promise.resolve({ kind: "owner", ownerId: "fixture", sessionId: "session" }),
      },
    },
  });

  assert.equal(
    (await app.request("/callbacks/telegram", { method: "POST", body: "{}" })).status,
    401,
  );
  assert.equal(received, 0);
  assert.equal(
    (
      await app.request("/callbacks/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1 }),
      })
    ).status,
    200,
  );
  assert.equal(received, 1);
  assert.equal(
    (
      await app.request("/callbacks/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
        body: "invalid",
      })
    ).status,
    400,
  );
  assert.equal(
    (await app.request("/api/owner/telegram/challenge", { method: "POST" })).status,
    403,
  );
  assert.equal(challenges, 0);
  assert.equal(
    (
      await app.request("/api/owner/telegram/challenge", {
        method: "POST",
        headers: { Origin: "https://web.example" },
      })
    ).status,
    200,
  );
  assert.equal(challenges, 1);
  store.receive = () => Promise.resolve({ callbackId: "synthetic", text: "Approved." });
  assert.equal(
    (
      await app.request("/callbacks/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 2 }),
      })
    ).status,
    200,
  );
  assert.deepEqual(acknowledgments, ["synthetic: Approved."]);
});
