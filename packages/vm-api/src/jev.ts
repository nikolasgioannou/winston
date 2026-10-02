/**
 * The Jev proxy (docs/design.md §5, Jev fast path): `winston browser
 * autopilot` asks Jev typed questions about a page through here, so the key
 * stays in the backend (§15). Jev is served by OpenRouter's decisions API.
 * Every call is logged in `jev_decisions` and charged to `cost_ledger`.
 * Jev is always optional: a failure says so, and the caller drives the page
 * itself.
 */
import type { DbOrTx } from "@winston/db/client";
import { costLedger, jevDecisions } from "@winston/db/schema";
import { apiError, apiErrors } from "@winston/domain/api-errors";
import { and, desc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { VmApiEnv } from "./env.ts";

/** A question's text, or JSON (TypeSafe's "entry type"). */
const entry = z.union([
  z.string().max(4000),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
]);

const question = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: entry.optional(),
    // Jev picks among at most 255 options.
    criteria: z.record(z.string().min(1).max(64), entry).refine((criteria) => {
      const count = Object.keys(criteria).length;
      return count >= 2 && count <= 255;
    }, "a choice needs 2 to 255 options"),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: entry.optional(),
    criteria: z
      .object({ true: entry.optional(), false: entry.optional() })
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal("score"),
    instructions: entry.optional(),
    criteria: z.array(entry).min(2).max(16),
  }),
]);

export const jevRequest = z.object({
  /** What Jev looks at: the goal, the page's snapshot, what's been done. */
  state: entry.refine(
    (state) => JSON.stringify(state).length <= 64_000,
    "the state is over 64 KB; send a shorter snapshot",
  ),
  questions: z
    .record(z.string().min(1).max(64), question)
    .refine((questions) => {
      const count = Object.keys(questions).length;
      return count >= 1 && count <= 8;
    }, "ask 1 to 8 questions"),
  /** The site's registrable domain, for per-site reliability. */
  domain: z.string().min(1).max(253).optional(),
});
export type JevRequest = z.infer<typeof jevRequest>;

export interface JevReply {
  answers: Record<string, unknown>;
  model: string;
  costUsd: number;
}

/** Asks Jev; throws `JevUnavailableError` when it can't answer. */
export interface Jev {
  decide(request: Pick<JevRequest, "state" | "questions">): Promise<JevReply>;
}

export class JevUnavailableError extends Error {}

/** How long a Jev call may take; it answers in about 300 ms. */
export const jevTimeoutMs = 5_000;

/** Jev through OpenRouter's decisions API (alpha), with the backend's key. */
export function openRouterJev({
  apiKey,
  model = "typesafe/jev-1.13",
  fetchImpl = fetch,
}: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Jev {
  return {
    async decide({ state, questions }) {
      let response: Response;
      try {
        response = await fetchImpl(
          "https://openrouter.ai/api/alpha/decisions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "Winston",
            },
            body: JSON.stringify({ model, state, questions }),
            signal: AbortSignal.timeout(jevTimeoutMs),
          },
        );
      } catch (error) {
        throw new JevUnavailableError(
          error instanceof Error && error.name === "TimeoutError"
            ? "Jev didn't answer in time."
            : "Jev couldn't be reached.",
        );
      }
      // The status only: a response body never reaches a message.
      if (!response.ok)
        throw new JevUnavailableError(
          `Jev answered ${String(response.status)}.`,
        );
      const body = (await response.json().catch(() => undefined)) as
        | {
            answers?: Record<string, unknown>;
            model?: string;
            usage?: { cost?: number };
          }
        | undefined;
      const missing = Object.keys(questions).filter(
        (name) => !body?.answers?.[name],
      );
      if (!body?.answers || missing.length > 0)
        throw new JevUnavailableError("Jev's answer was incomplete.");
      return {
        answers: body.answers,
        model: body.model ?? model,
        costUsd: body.usage?.cost ?? 0,
      };
    },
  };
}

/**
 * Per-site reliability (§5): over a site's last decided picks, Jev is off
 * there once at least `minDecided` are known and most were overridden.
 */
export const siteReliability = {
  window: 30,
  minDecided: 6,
  maxOverridden: 0.5,
};

const outcomeBody = z.object({
  decisions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        /** What was done with the pick, e.g. `click e5 (link "Bun")`; null if nothing. */
        action: z.string().max(300).nullable(),
      }),
    )
    .min(1)
    .max(50),
  outcome: z.enum(["verified", "overridden"]),
});

export function jevRoutes({ db, jev }: { db: DbOrTx; jev?: Jev | undefined }) {
  return new Hono<VmApiEnv>()
    .get("/sites/:domain", async (c) => {
      const recent = await db
        .select({ outcome: jevDecisions.outcome })
        .from(jevDecisions)
        .where(
          and(
            eq(jevDecisions.domain, c.req.param("domain")),
            ne(jevDecisions.outcome, "unknown"),
          ),
        )
        .orderBy(desc(jevDecisions.createdAt))
        .limit(siteReliability.window);
      const overridden = recent.filter(
        (d) => d.outcome === "overridden",
      ).length;
      return c.json({
        decided: recent.length,
        overridden,
        reliable:
          recent.length < siteReliability.minDecided ||
          overridden / recent.length <= siteReliability.maxOverridden,
      });
    })
    .post("/outcome", async (c) => {
      const body = outcomeBody.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!body.success)
        return c.json(
          apiError("invalid_request", z.prettifyError(body.error)),
          apiErrors.invalid_request.status,
        );
      const { userId } = c.get("run");
      for (const { id, action } of body.data.decisions)
        await db
          .update(jevDecisions)
          .set({ action, outcome: body.data.outcome })
          .where(
            and(
              eq(jevDecisions.id, id),
              // Only this user's decisions.
              eq(jevDecisions.userId, userId),
            ),
          );
      return c.json({ recorded: body.data.decisions.length });
    })
    .post("/decide", async (c) => {
      const body = jevRequest.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!body.success)
        return c.json(
          apiError("invalid_request", z.prettifyError(body.error)),
          apiErrors.invalid_request.status,
        );
      const unavailable = (message: string) =>
        c.json(
          apiError(
            "unavailable",
            message,
            "Drive the page yourself: snapshot, then act on refs.",
          ),
          apiErrors.unavailable.status,
        );
      if (!jev) return unavailable("Jev isn't set up here.");
      const { userId, runId } = c.get("run");
      const { state, questions, domain } = body.data;
      const started = performance.now();
      let reply: JevReply | undefined;
      let error: string | undefined;
      try {
        reply = await jev.decide({ state, questions });
      } catch (failure) {
        if (!(failure instanceof JevUnavailableError)) throw failure;
        error = failure.message;
      }
      const latencyMs = Math.round(performance.now() - started);
      const [decision] = await db
        .insert(jevDecisions)
        .values({
          userId,
          runId,
          domain: domain ?? null,
          question: { state, questions },
          answer: reply?.answers ?? null,
          model: reply?.model ?? null,
          error: error ?? null,
          latencyMs,
        })
        .returning({ id: jevDecisions.id });
      if (!reply || !decision) return unavailable(error ?? "Jev failed.");
      if (reply.costUsd > 0)
        await db.insert(costLedger).values({
          userId,
          runId,
          category: "jev",
          costUsd: reply.costUsd.toFixed(6),
        });
      return c.json({
        decisionId: decision.id,
        answers: reply.answers,
        model: reply.model,
        latencyMs,
      });
    });
}
