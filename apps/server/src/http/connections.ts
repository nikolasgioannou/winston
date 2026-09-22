import { Hono } from "hono";
import type { GoogleConnections } from "@winston/adapters/google";
import {
  connectionStartSchema,
  connectionSchema,
  calendarSelectionSchema,
} from "@winston/contracts/connections";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export function createConnectionOwnerRouter(store: GoogleConnections) {
  const router = new Hono<HttpEnvironment>();
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    return context.json(await store.list(owner.ownerId));
  });
  router.post("/google", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner" || !owner.sessionId) throw new RequestError("unauthorized");
    const intent = await parseJson(context, connectionStartSchema);
    return context.json(await store.start(owner.ownerId, owner.sessionId, intent));
  });
  router.get("/:id/calendars", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = connectionSchema.shape.id.safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("invalid_request");
    return context.json(await store.calendars(owner.ownerId, id.data, context.req.raw.signal));
  });
  router.put("/:id/calendars", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = connectionSchema.shape.id.safeParse(context.req.param("id"));
    if (!id.success) throw new RequestError("invalid_request");
    const input = await parseJson(context, calendarSelectionSchema);
    return context.json(
      await store.selectCalendars(
        owner.ownerId,
        id.data,
        input.revision,
        input.ids,
        context.req.raw.signal,
      ),
    );
  });
  return router;
}

export function createConnectionCallbackRouter(store: GoogleConnections, webOrigin: string) {
  const router = new Hono<HttpEnvironment>();
  router.get("/google/connections", async (context) => {
    const identity = context.get("identity");
    if (
      identity.kind !== "callback" ||
      identity.provider !== "google" ||
      !identity.ownerId ||
      !identity.sessionId
    )
      throw new RequestError("unauthorized");
    const code = context.req.query("code");
    const state = context.req.query("state");
    let result = "failed";
    try {
      if (
        !code ||
        code.length > 4096 ||
        !state ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        context.req.query("error")
      )
        throw new Error();
      const connection = await store.finish(
        identity.ownerId,
        identity.sessionId,
        state,
        code,
        context.req.raw.signal,
      );
      result = connection.status === "limited" ? "limited" : "connected";
    } catch {
      // Provider exceptions and callback query values can contain credentials. Never log them.
    }
    context.header("Referrer-Policy", "no-referrer");
    return context.redirect(`${webOrigin}/?connection_result=${result}`, 303);
  });
  return router;
}
