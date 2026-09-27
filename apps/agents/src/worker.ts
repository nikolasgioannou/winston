import type { Db } from "@winston/db/client";
import {
  complete,
  extendLease,
  fail,
  lease,
  type Job,
} from "@winston/db/queue";
import type { Logger } from "@winston/shared/logger";

/** What a job handler gets to work with. */
export interface JobContext {
  job: Job;
  db: Db;
  /** Tagged with the job's id, type and user. */
  logger: Logger;
  /** Keeps the job leased during long work. Returns false if the lease was lost. */
  extendLease: (ms: number) => Promise<boolean>;
}

export type JobHandler = (context: JobContext) => Promise<void>;

export interface WorkerOptions {
  db: Db;
  logger: Logger;
  /** Handlers by job type. Only these types are leased. */
  handlers: Record<string, JobHandler>;
  /** How many jobs run at once. */
  concurrency: number;
  leaseMs?: number;
  /** How long to wait before polling again when no job was due. */
  idleMs?: number;
}

/**
 * Leases jobs for the registered types and runs their handlers, up to
 * `concurrency` at a time. `stop()` stops leasing and waits for in-flight
 * handlers; anything cut short is recovered when its lease expires.
 */
export function createWorker({
  db,
  logger,
  handlers,
  concurrency,
  leaseMs = 60_000,
  idleMs = 500,
}: WorkerOptions) {
  const types = Object.keys(handlers);
  const inFlight = new Set<Promise<void>>();
  let running = false;
  // Read through a function: `stop()` can flip it while the loop awaits, which
  // TypeScript's narrowing can't see.
  const isRunning = () => running;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run(leased: Awaited<ReturnType<typeof lease>>[number]) {
    const { job } = leased;
    const jobLogger = logger.child({
      jobId: job.id,
      jobType: job.type,
      userId: job.userId ?? undefined,
    });
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler({
        job,
        db,
        logger: jobLogger,
        extendLease: (ms) => extendLease(db, leased, ms),
      });
      if (!(await complete(db, leased)))
        jobLogger.warn("lease lost before completion");
    } catch (error) {
      jobLogger.error({ err: error, attempt: job.attempts }, "job failed");
      await fail(db, leased, error).catch((failError: unknown) => {
        jobLogger.error({ err: failError }, "recording the failure failed");
      });
    }
  }

  async function nextLeases() {
    const free = concurrency - inFlight.size;
    if (free <= 0 || types.length === 0) return [];
    try {
      return await lease(db, { types, leaseMs, limit: free });
    } catch (error) {
      // A database blip shouldn't kill the worker; try again after a pause.
      logger.error({ err: error }, "leasing failed");
      return [];
    }
  }

  async function poll() {
    while (isRunning()) {
      const leases = await nextLeases();
      for (const leased of leases) {
        const task = run(leased).finally(() => {
          inFlight.delete(task);
          wake?.();
        });
        inFlight.add(task);
      }
      if (isRunning() && (leases.length === 0 || inFlight.size >= concurrency))
        await sleep(idleMs);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop = poll();
    },
    /** Stops leasing and waits for in-flight handlers to finish. */
    async stop() {
      running = false;
      wake?.();
      await loop;
      await Promise.all(inFlight);
    },
  };
}
