/**
 * The Postgres job queue (docs/design.md §9, §17). Leasing uses
 * `FOR UPDATE SKIP LOCKED`, so workers never take the same job, and all timing
 * uses the database's clock. Work happens outside any transaction: lease, do
 * the work, then `complete` or `fail` with the lease you were given.
 */
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { jobs } from "./schema/index.ts";

export type Job = typeof jobs.$inferSelect;

/** A leased job plus the token that proves the lease is still yours. */
export interface Lease {
  job: Job;
  token: string;
}

export interface EnqueueOptions {
  payload?: unknown;
  userId?: string;
  /** When the job becomes due. Defaults to now. */
  runAt?: Date;
  /** Due this long from now by the database's clock. Overrides `runAt`. */
  delayMs?: number;
  maxAttempts?: number;
  /** At most one queued job per key. */
  dedupeKey?: string;
  /**
   * When a job with the same key is already queued: `ignore` leaves it as it
   * is (the default); `reschedule` moves its run time to this call's, which is
   * how a debounce pushes a job later with every new trigger.
   */
  onDuplicate?: "ignore" | "reschedule";
}

// The dedupe index only covers queued jobs, so conflicts must name the same condition.
const queuedOnly = sql`status = 'queued'`;

/**
 * Adds a job. Pass a transaction to enqueue atomically with other writes.
 * Returns the id of the job that will run (the existing one for duplicates).
 */
export async function enqueue(
  db: DbOrTx,
  type: string,
  options: EnqueueOptions = {},
) {
  const insert = db.insert(jobs).values({
    type,
    payload: options.payload ?? {},
    userId: options.userId,
    runAt:
      options.delayMs === undefined
        ? options.runAt
        : sql`now() + ${options.delayMs} * interval '1 millisecond'`,
    maxAttempts: options.maxAttempts,
    dedupeKey: options.dedupeKey,
  });
  const [row] =
    options.onDuplicate === "reschedule"
      ? await insert
          .onConflictDoUpdate({
            target: jobs.dedupeKey,
            targetWhere: queuedOnly,
            // The run time this call would have inserted.
            set: { runAt: sql`excluded.run_at` },
          })
          .returning({ id: jobs.id })
      : await insert
          .onConflictDoNothing({ target: jobs.dedupeKey, where: queuedOnly })
          .returning({ id: jobs.id });
  if (row) return row.id;

  // A queued job with the same key already exists and was left as it was.
  const key = options.dedupeKey ?? "";
  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, key), eq(jobs.status, "queued")));
  if (!existing) throw new Error(`Enqueueing ${type} returned no job.`);
  return existing.id;
}

/**
 * Leases up to `limit` due jobs of the given types for `leaseMs`. A job whose
 * lease expired (its worker crashed or stalled) is leasable again.
 */
export async function lease(
  db: DbOrTx,
  options: { types: readonly string[]; leaseMs: number; limit?: number },
): Promise<Lease[]> {
  const token = crypto.randomUUID();
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.type, [...options.types]),
        or(
          and(eq(jobs.status, "queued"), lte(jobs.runAt, sql`now()`)),
          and(eq(jobs.status, "running"), lt(jobs.lockedUntil, sql`now()`)),
        ),
      ),
    )
    .orderBy(jobs.runAt)
    .limit(options.limit ?? 1)
    .for("update", { skipLocked: true });

  const leased = await db
    .update(jobs)
    .set({
      status: "running",
      leaseToken: token,
      lockedUntil: sql`now() + ${options.leaseMs} * interval '1 millisecond'`,
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(inArray(jobs.id, due))
    .returning();
  return leased.map((job) => ({ job, token }));
}

/** Matches the job only while this lease is still the current one. */
function held({ job, token }: Lease) {
  return and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    eq(jobs.leaseToken, token),
  );
}

/** Marks a leased job done. Returns false if the lease was lost (expired and re-leased). */
export async function complete(db: DbOrTx, lease: Lease) {
  const done = await db
    .update(jobs)
    .set({
      status: "done",
      finishedAt: sql`now()`,
      lockedUntil: null,
      leaseToken: null,
    })
    .where(held(lease))
    .returning({ id: jobs.id });
  return done.length > 0;
}

/**
 * Records a failed attempt. The job is retried after an exponential backoff
 * with jitter, or marked failed once it has used `maxAttempts`. Returns false
 * if the lease was lost.
 */
export async function fail(db: DbOrTx, lease: Lease, error: unknown) {
  const exhausted = lease.job.attempts >= lease.job.maxAttempts;
  const message = error instanceof Error ? error.message : String(error);
  const updated = await db
    .update(jobs)
    .set(
      exhausted
        ? {
            status: "failed",
            finishedAt: sql`now()`,
            lastError: message,
            lockedUntil: null,
            leaseToken: null,
          }
        : {
            status: "queued",
            runAt: sql`now() + ${retryDelayMs(lease.job.attempts)} * interval '1 millisecond'`,
            lastError: message,
            lockedUntil: null,
            leaseToken: null,
          },
    )
    .where(held(lease))
    .returning({ id: jobs.id });
  return updated.length > 0;
}

/** Extends a lease for long work. Returns false if the lease was already lost. */
export async function extendLease(db: DbOrTx, lease: Lease, leaseMs: number) {
  const extended = await db
    .update(jobs)
    .set({ lockedUntil: sql`now() + ${leaseMs} * interval '1 millisecond'` })
    .where(held(lease))
    .returning({ id: jobs.id });
  return extended.length > 0;
}

const baseDelayMs = 1_000;
const maxDelayMs = 5 * 60_000;

/**
 * Delay before retrying after `attempts` failed attempts: exponential, capped
 * at five minutes, with jitter (50–100% of the delay) so retries don't bunch up.
 */
export function retryDelayMs(
  attempts: number,
  random: () => number = Math.random,
) {
  const delay = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempts - 1),
  );
  return Math.round(delay * (0.5 + random() * 0.5));
}
