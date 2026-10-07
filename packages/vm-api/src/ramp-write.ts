/**
 * Acting in the user's Ramp (944c5b, docs/design.md §5): memos and comments
 * (`edit`), submitting a draft reimbursement (`submit`), and approving or
 * rejecting what waits on the user (`approve`). Like mail and calendar
 * writes: the capability is checked first, `dryRun` shows exactly what would
 * happen and changes nothing, and every real write is audited.
 */
import type { RampObjectKind, RampProvider } from "@winston/connectors/ramp";
import { audited } from "@winston/db/audit";
import type { DbOrTx } from "@winston/db/client";
import { resolveRef } from "@winston/db/external-refs";
import { connections } from "@winston/db/schema";
import type { Capability } from "@winston/domain/connections";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  ApiFailure,
  requireCapability,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const kinds = {
  transactions: "rampTransaction",
  reimbursements: "rampReimbursement",
  requests: "rampRequest",
} as const satisfies Record<string, RampObjectKind>;
type Plural = keyof typeof kinds;

const updateBody = z
  .object({
    memo: z.string().max(2000).optional(),
    comment: z.string().min(1).max(2000).optional(),
    dryRun: z.boolean().default(false),
  })
  .refine((b) => b.memo !== undefined || b.comment !== undefined, {
    message: "Nothing to change: give a memo or a comment.",
  });
const decideBody = z.object({
  note: z.string().min(1).max(2000).optional(),
  dryRun: z.boolean().default(false),
});
const submitBody = z.object({ dryRun: z.boolean().default(false) });

const body = <T extends z.ZodType>(schema: T) =>
  validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiFailure("invalid_request", z.prettifyError(parsed.error));
    return parsed.data;
  });

export function rampWriteRoutes({
  db,
  connectors,
}: {
  db: DbOrTx;
  connectors: ConnectorDeps | undefined;
}) {
  /**
   * The object an id names, its connection and provider, after checking the
   * capability the change needs. A wrong kind of id is not found.
   */
  async function target(
    userId: string,
    id: string,
    plural: Plural,
    capability: Capability<"ramp">,
  ) {
    const ramp = connectors?.ramp;
    if (!connectors || !ramp)
      throw new ApiFailure("unavailable", "Ramp isn't available here.");
    const ref = await resolveRef(db, userId, id);
    const [connection] = ref
      ? await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.id, ref.connectionId),
              eq(connections.userId, userId),
            ),
          )
      : [];
    if (ref?.kind !== kinds[plural] || !connection)
      throw new ApiFailure(
        "not_found",
        `There's no ${id}.`,
        `Use an id from winston ramp ${plural} list.`,
      );
    requireCapability(connection, capability, connectors.webPublicUrl);
    return {
      connection,
      provider: ramp(connection),
      providerId: ref.providerId,
    };
  }

  /** What a write is about, for its preview and audit summary. */
  async function describeTarget(
    provider: RampProvider,
    plural: Plural,
    providerId: string,
  ) {
    if (plural === "transactions") {
      const t = await provider.transaction(providerId);
      return {
        what: `${t.merchant} ${t.amount ?? ""}`.trim(),
        who: t.spentBy,
        memo: t.memo,
      };
    }
    if (plural === "reimbursements") {
      const r = await provider.reimbursement(providerId);
      return {
        what: `${r.merchant ?? "reimbursement"} ${r.amount}`.trim(),
        who: null,
        memo: r.memo,
        status: r.status,
      };
    }
    const r = await provider.request(providerId);
    return {
      what: `${r.name ?? r.kind ?? "request"} ${r.amount ?? ""}`.trim(),
      who: r.requester,
      memo: r.reason,
    };
  }

  const account = (connection: ConnectionRow) => ({
    id: connection.id,
    email: connection.externalEmail,
  });

  interface Run {
    userId: string;
    runId: string | null;
  }

  /** Sets a memo and/or comments (`edit`). */
  async function update(
    { userId, runId }: Run,
    plural: "transactions" | "reimbursements",
    id: string,
    input: z.infer<typeof updateBody>,
  ) {
    const { connection, provider, providerId } = await target(
      userId,
      id,
      plural,
      "edit",
    );
    const about = await describeTarget(provider, plural, providerId);
    const changes = {
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
    };
    const result = { account: account(connection), id, about, changes };
    if (input.dryRun) return { ...result, dryRun: true as const };
    const kind = kinds[plural];
    await audited(
      db,
      {
        userId,
        runId,
        connectionId: connection.id,
        action: `ramp.${plural === "transactions" ? "transaction" : "reimbursement"}.update`,
        targetRef: id,
        summary: `Updated ${about.what}${input.memo === undefined ? "" : ": memo"}${input.comment === undefined ? "" : ", commented"}`,
        request: { id, ...changes },
      },
      async () => {
        if (input.memo !== undefined)
          await provider.setMemo(kind, providerId, input.memo);
        if (input.comment !== undefined)
          await provider.comment(kind, providerId, input.comment);
      },
    );
    return { ...result, dryRun: false as const };
  }

  /** Approves or rejects (`approve`). */
  async function decide(
    { userId, runId }: Run,
    plural: Plural,
    decision: "approve" | "reject",
    id: string,
    input: z.infer<typeof decideBody>,
  ) {
    const { connection, provider, providerId } = await target(
      userId,
      id,
      plural,
      "approve",
    );
    if (plural === "transactions" && decision === "reject" && !input.note)
      throw new ApiFailure(
        "invalid_request",
        "Rejecting a transaction sends it back to the cardholder with the changes asked for, so it needs a note.",
        "Add --note with what they should change.",
      );
    const about = await describeTarget(provider, plural, providerId);
    const result = {
      account: account(connection),
      id,
      decision,
      note: input.note ?? null,
      about,
    };
    if (input.dryRun) return { ...result, dryRun: true as const };
    await audited(
      db,
      {
        userId,
        runId,
        connectionId: connection.id,
        action: `ramp.${decision}`,
        targetRef: id,
        summary: `${decision === "approve" ? "Approved" : "Rejected"} ${about.what}${about.who ? ` from ${about.who}` : ""}`,
        request: { id, note: input.note },
      },
      () => provider.decide(kinds[plural], providerId, decision, input.note),
    );
    return { ...result, dryRun: false as const };
  }

  /** Submits a draft reimbursement (`submit`). */
  async function submit(
    { userId, runId }: Run,
    id: string,
    input: z.infer<typeof submitBody>,
  ) {
    const { connection, provider, providerId } = await target(
      userId,
      id,
      "reimbursements",
      "submit",
    );
    const about = await describeTarget(provider, "reimbursements", providerId);
    const result = { account: account(connection), id, about };
    if (input.dryRun) return { ...result, dryRun: true as const };
    await audited(
      db,
      {
        userId,
        runId,
        connectionId: connection.id,
        action: "ramp.reimbursement.submit",
        targetRef: id,
        summary: `Submitted ${about.what}`,
        request: { id },
      },
      () => provider.submitReimbursement(providerId),
    );
    return { ...result, dryRun: false as const };
  }

  return new Hono<VmApiEnv>()
    .post("/transactions/:id/update", body(updateBody), async (c) =>
      c.json(
        await update(
          c.get("run"),
          "transactions",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/reimbursements/:id/update", body(updateBody), async (c) =>
      c.json(
        await update(
          c.get("run"),
          "reimbursements",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/reimbursements/:id/submit", body(submitBody), async (c) =>
      c.json(
        await submit(c.get("run"), c.req.param("id"), c.req.valid("json")),
      ),
    )
    .post("/transactions/:id/approve", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "transactions",
          "approve",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/transactions/:id/reject", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "transactions",
          "reject",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/reimbursements/:id/approve", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "reimbursements",
          "approve",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/reimbursements/:id/reject", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "reimbursements",
          "reject",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/requests/:id/approve", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "requests",
          "approve",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    )
    .post("/requests/:id/reject", body(decideBody), async (c) =>
      c.json(
        await decide(
          c.get("run"),
          "requests",
          "reject",
          c.req.param("id"),
          c.req.valid("json"),
        ),
      ),
    );
}
