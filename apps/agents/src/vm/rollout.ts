/**
 * Image rollouts (docs/design.md §18): anything baked into the VM image
 * (system packages, Chrome, its units) reaches existing VMs by moving them
 * onto the current image, the way a deploy moves the services. The move is
 * the replace path: a new instance from the new image on the same data
 * volume, so notes, files and logins carry over. It happens only when it
 * won't be noticed: in the user's quiet hours, with nothing running and no
 * live handoff. A VM that's busy waits for the next sweep.
 */
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { handoffs, runs, users, vms } from "@winston/db/schema";
import { rollVmJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { JobHandler } from "../worker.ts";
import { provisionVm } from "./provision.ts";
import type { VmProvider } from "./provider.ts";

export const rolloutEveryMs = 15 * 60_000;

/** A live handoff this recent holds a rollout back (older ones are forgotten tabs). */
const handoffHoldsMs = 24 * 60 * 60_000;

export interface QuietHours {
  from: number;
  to: number;
}

/** "3-5" as hours; the whole day for "0-24". */
export function parseHours(value: string): QuietHours {
  const [from, to] = value.split("-").map(Number);
  return { from: from ?? 0, to: to ?? 24 };
}

/** Whether it's within `hours` where the user is (a range may wrap midnight). */
export function inHours(hours: QuietHours, timeZone: string, now: Date) {
  if (hours.from === 0 && hours.to >= 24) return true;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  return hours.from <= hours.to
    ? hour >= hours.from && hour < hours.to
    : hour >= hours.from || hour < hours.to;
}

/**
 * Users whose ready VM is on another image than `current` (or one never
 * recorded), and who are in their rollout hours with nothing in progress.
 */
export async function vmsToRoll(
  db: DbOrTx,
  current: string,
  hours: QuietHours,
  now = new Date(),
) {
  const outdated = await db
    .select({ userId: vms.userId, timeZone: users.timezone })
    .from(vms)
    .innerJoin(users, eq(users.id, vms.userId))
    .where(
      and(
        eq(vms.state, "ready"),
        or(isNull(vms.imageId), ne(vms.imageId, current)),
      ),
    );
  const due = outdated.filter((row) => inHours(hours, row.timeZone, now));
  if (due.length === 0) return [];
  const ids = due.map((row) => row.userId);
  const running = await db
    .selectDistinct({ userId: runs.userId })
    .from(runs)
    .where(and(inArray(runs.userId, ids), eq(runs.status, "running")));
  const handingOver = await db
    .selectDistinct({ userId: handoffs.userId })
    .from(handoffs)
    .where(
      and(
        inArray(handoffs.userId, ids),
        inArray(handoffs.status, ["open", "connected"]),
        gt(
          handoffs.createdAt,
          sql`now() - ${handoffHoldsMs} * interval '1 millisecond'`,
        ),
      ),
    );
  const busy = new Set([...running, ...handingOver].map((row) => row.userId));
  return ids.filter((id) => !busy.has(id));
}

/** Queues a roll for each VM that should move now (one queued per user). */
export async function sweepRollouts(
  db: DbOrTx,
  logger: Logger,
  provider: VmProvider,
  hours: QuietHours,
) {
  const current = await provider.currentImage();
  if (!current) return 0;
  const userIds = await vmsToRoll(db, current, hours);
  for (const userId of userIds)
    await enqueue(db, rollVmJob.type, {
      userId,
      payload: { image: current },
      dedupeKey: rollVmJob.dedupeKey(userId),
      maxAttempts: rollVmJob.maxAttempts,
    });
  if (userIds.length > 0)
    logger.info(
      { vms: userIds.length, image: current },
      "rolling VMs onto the current image",
    );
  return userIds.length;
}

/**
 * The `roll_vm` job: checks again that the VM should move (the user may have
 * started something since the sweep), then replaces its instance.
 */
export function rollVmHandler(
  provider: VmProvider,
  hours: QuietHours,
): JobHandler {
  return async ({ job, db, logger }) => {
    const userId = job.userId;
    if (!userId) throw new Error("roll_vm job has no user");
    const current = await provider.currentImage();
    if (!current) return;
    // `bun run prod vm:roll` moves it now: any hour, but still not while busy.
    const now = (job.payload as { now?: unknown } | null)?.now === true;
    const window = now ? parseHours("0-24") : hours;
    if (!(await vmsToRoll(db, current, window)).includes(userId)) {
      logger.info("not rolling: the VM is current, busy, or out of its hours");
      return;
    }
    await provisionVm({ db, logger, provider }, userId, { replace: true });
    logger.info({ image: current }, "VM rolled onto the current image");
  };
}
