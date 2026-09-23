import { Hono } from "hono";
import { z } from "zod";
import type { TelegramStore } from "@winston/adapters/telegram";
import { telegramUpdateSchema } from "@winston/contracts/telegram";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export function createTelegramOwnerRouter(store: TelegramStore, username: string) {
  const router = new Hono<HttpEnvironment>();
  const identity = (context: {
    get(key: "identity"): HttpEnvironment["Variables"]["identity"];
  }) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner" || !owner.sessionId) throw new RequestError("unauthorized");

    return { ownerId: owner.ownerId, sessionId: owner.sessionId };
  };

  router.get("/", async (context) => {
    const owner = identity(context);

    return context.json(await store.status(owner.ownerId, owner.sessionId));
  });
  router.post("/challenge", async (context) => {
    const owner = identity(context);
    const challenge = await store.challenge(owner.ownerId, owner.sessionId);

    return context.json({
      id: challenge.id,
      url: `https://t.me/${username}?start=${challenge.secret}`,
    });
  });
  router.post("/confirm", async (context) => {
    const owner = identity(context);
    const { id } = await parseJson(context, z.strictObject({ id: z.uuid() }));
    const confirmed = await store.confirm(owner.ownerId, owner.sessionId, id);

    if (!confirmed) throw new RequestError("forbidden");

    return context.json({ confirmed: true });
  });
  router.delete("/", async (context) => {
    const owner = identity(context);
    await store.unpair(owner.ownerId);

    return context.json({ disconnected: true });
  });

  return router;
}

export function createTelegramCallbackRouter(
  store: TelegramStore,
  answer: (id: string, text: string) => Promise<void>,
) {
  const router = new Hono<HttpEnvironment>();
  router.post("/telegram", async (context) => {
    const identity = context.get("identity");
    if (identity.kind !== "callback" || identity.provider !== "telegram")
      throw new RequestError("forbidden");
    const result = await store.receive(await parseJson(context, telegramUpdateSchema));
    if (typeof result === "object") {
      try {
        await answer(result.callbackId, result.text);
      } catch {
        // The durable decision is already committed; an expired toast cannot undo it.
        console.error("Telegram callback acknowledgment failed.");
      }
    }

    return context.json({ ok: true });
  });

  return router;
}
