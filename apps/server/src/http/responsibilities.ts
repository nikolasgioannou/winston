import { Hono } from "hono";
import { z } from "zod";
import { ResponsibilityWriteError, type OwnerTransaction } from "@winston/adapters/database";
import {
  ownerResponsibilityProposalSchema,
  ownerResponsibilityEditSchema,
  ownerResponsibilityRevisionSchema,
  responsibilitySchema,
} from "@winston/contracts/responsibilities";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

type Scope = Pick<OwnerTransaction, "responsibilities">;
export function createResponsibilityOwnerRouter(database: {
  transaction<T>(ownerId: string, work: (scope: Scope) => Promise<T>): Promise<T>;
}) {
  const router = new Hono<HttpEnvironment>();
  async function transact<T>(ownerId: string, work: (scope: Scope) => Promise<T>) {
    try {
      return await database.transaction(ownerId, work);
    } catch (error) {
      if (error instanceof ResponsibilityWriteError)
        throw new RequestError(error.kind === "invalid_scope" ? "invalid_request" : error.kind);
      throw error;
    }
  }
  function identifier(value: string) {
    const result = z.uuid().safeParse(value);
    if (!result.success) throw new RequestError("not_found");
    return result.data;
  }
  router.get("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const after = context.req.query("after");
    if (after !== undefined && !z.uuid().safeParse(after).success)
      throw new RequestError("invalid_request");
    const items = await transact(owner.ownerId, ({ responsibilities }) =>
      responsibilities.list(after),
    );
    return context.json({ items, next: items.length === 100 ? items.at(-1)?.id : null });
  });
  router.get("/:id/sources", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    return context.json(
      await transact(owner.ownerId, ({ responsibilities }) => responsibilities.sources(id)),
    );
  });
  router.get("/:id/history", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const cursor = context.req.query("before");
    let before: number | undefined;
    if (cursor !== undefined) {
      const parsed = responsibilitySchema.shape.revision.safeParse(Number(cursor));
      if (!/^\d+$/.test(cursor) || !parsed.success) throw new RequestError("invalid_request");
      before = parsed.data;
    }
    return context.json(
      await transact(owner.ownerId, ({ responsibilities }) => responsibilities.history(id, before)),
    );
  });
  router.get("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const value = await transact(owner.ownerId, ({ responsibilities }) =>
      responsibilities.find(id),
    );
    if (!value) throw new RequestError("not_found");
    return context.json(value);
  });
  router.post("/", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const input = await parseJson(context, ownerResponsibilityProposalSchema);
    return context.json(
      await transact(owner.ownerId, ({ responsibilities }) =>
        responsibilities.propose({ ...input, key: `web:${input.key}`, sourceMessageIds: [] }),
      ),
    );
  });
  router.put("/:id", async (context) => {
    const owner = context.get("identity");
    if (owner.kind !== "owner") throw new RequestError("unauthorized");
    const id = identifier(context.req.param("id"));
    const input = await parseJson(context, ownerResponsibilityEditSchema);
    return context.json(
      await transact(owner.ownerId, async ({ responsibilities }) => {
        const current = await responsibilities.find(id);
        if (!current) throw new RequestError("not_found");
        return responsibilities.revise(id, input.revision, {
          purpose: input.purpose,
          scope: input.scope,
          sourceMessageIds: current.sources.map((source) => source.messageId),
        });
      }),
    );
  });
  for (const action of ["agree", "pause", "resume", "end"] as const) {
    router.post(`/:id/${action}`, async (context) => {
      const owner = context.get("identity");
      if (owner.kind !== "owner") throw new RequestError("unauthorized");
      const id = identifier(context.req.param("id"));
      const { revision } = await parseJson(context, ownerResponsibilityRevisionSchema);
      return context.json(
        await transact(owner.ownerId, ({ responsibilities }) =>
          action === "agree"
            ? responsibilities.agree(id, revision)
            : responsibilities.transition(
                id,
                revision,
                action === "pause" ? "paused" : action === "resume" ? "active" : "ended",
              ),
        ),
      );
    });
  }
  return router;
}
