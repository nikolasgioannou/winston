import { createHash } from "node:crypto";
import { PgBoss } from "pg-boss";
import { jobReferenceSchema, type JobReference } from "@winston/contracts/jobs";

export const workloads = {
  conversation: { concurrency: 4, expireInSeconds: 90 },
  background: { concurrency: 2, expireInSeconds: 86400 },
  transcription: { concurrency: 2, expireInSeconds: 120 },
  maintenance: { concurrency: 1, expireInSeconds: 300 },
} as const;
export type Workload = keyof typeof workloads;
type Handler = (reference: JobReference, signal: AbortSignal) => Promise<void>;

function identity(workload: Workload, reference: JobReference) {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([workload, reference.ownerId, reference.referenceId, reference.revision]),
    )
    .digest();
  // Stable UUID with RFC variant/version bits. Domain consumers must still deduplicate after retention.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createJobRuntime(options: {
  directConnectionString: string;
  onNotice: (code: "queue-error" | "queue-warning") => void;
}) {
  const boss = new PgBoss({
    connectionString: options.directConnectionString,
    max: 12,
    useListenNotify: true,
    superviseIntervalSeconds: 5,
    monitorIntervalSeconds: 5,
    schedule: false,
  });
  const health = { errors: 0, warnings: 0 };
  boss.on("error", () => {
    health.errors += 1;
    options.onNotice("queue-error");
  });
  boss.on("warning", () => {
    health.warnings += 1;
    options.onNotice("queue-warning");
  });
  const active = new Set<Workload>();
  const queue = (workload: Workload) => `winston-${workload}`;

  return {
    health: () => ({ ...health }),
    async start() {
      try {
        await boss.start();
        await boss.createQueue("winston-failed", { retryLimit: 0, deleteAfterSeconds: 30 * 86400 });
        for (const workload of Object.keys(workloads) as Workload[]) {
          await boss.createQueue(queue(workload), {
            notify: true,
            heartbeatSeconds: 20,
            expireInSeconds: workloads[workload].expireInSeconds,
            retryLimit: 3,
            retryDelay: 1,
            retryBackoff: true,
            retryDelayMax: 60,
            deadLetter: "winston-failed",
            deleteAfterSeconds: 7 * 86400,
          });
          // createQueue leaves existing queues intact; reconcile changed runtime settings too.
          await boss.updateQueue(queue(workload), {
            heartbeatSeconds: 20,
            expireInSeconds: workloads[workload].expireInSeconds,
          });
        }
      } catch {
        await boss.stop().catch(() => {});
        throw new Error("Queue startup failed. Check the direct database connection.");
      }
    },
    async enqueue(workload: Workload, input: JobReference) {
      const reference = jobReferenceSchema.parse(input);
      const id = identity(workload, reference);
      await boss.send(queue(workload), reference, { id, group: { id: reference.ownerId } });

      return id;
    },
    async inspect(workload: Workload, input: JobReference) {
      const reference = jobReferenceSchema.parse(input);
      const jobs = await boss.findJobs<unknown>(queue(workload), {
        id: identity(workload, reference),
      });
      const job = jobs[0];
      if (!job || jobReferenceSchema.parse(job.data).ownerId !== reference.ownerId)
        return undefined;

      return {
        id: job.id,
        state: job.state,
        retries: job.retryCount,
        terminalFailure: job.state === "failed",
      };
    },
    async cancel(workload: Workload, input: JobReference) {
      const reference = jobReferenceSchema.parse(input);
      await boss.cancel(queue(workload), identity(workload, reference));
    },
    async work(workload: Workload, handler: Handler) {
      if (active.has(workload)) throw new Error("Workload already has a registered handler.");
      active.add(workload);
      try {
        await boss.work<unknown>(
          queue(workload),
          {
            localConcurrency: workloads[workload].concurrency,
            groupConcurrency: workload === "conversation" ? 1 : workloads[workload].concurrency,
            pollingIntervalSeconds: 0.5,
            notifyPollingIntervalSeconds: 5,
            heartbeatRefreshSeconds: 5,
            batchSize: 1,
          },
          async (jobs) => {
            const job = jobs[0];
            if (!job) return;
            let onAbort: (() => void) | undefined;
            try {
              const reference = jobReferenceSchema.parse(job.data);
              job.signal.throwIfAborted();
              const aborted = new Promise<never>((_resolve, reject) => {
                onAbort = () => {
                  reject(new Error("Worker job interrupted."));
                };
                job.signal.addEventListener("abort", onAbort, { once: true });
                if (job.signal.aborted) onAbort();
              });
              await Promise.race([handler(reference, job.signal), aborted]);
              job.signal.throwIfAborted();
            } catch {
              // pg-boss persists handler errors. Never include external errors or job contents.
              throw new Error("Worker job failed.");
            } finally {
              if (onAbort) job.signal.removeEventListener("abort", onAbort);
            }
          },
        );
      } catch {
        active.delete(workload);
        throw new Error("Worker registration failed.");
      }
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 10_000 });
      active.clear();
    },
  };
}
