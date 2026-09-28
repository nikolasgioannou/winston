import { enqueue } from "@winston/db/queue";
import { frontTurnJob } from "@winston/domain/jobs";
import type { BlobStore } from "../blobs.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { VmClient } from "../vm/gateway-client.ts";
import type { Timers } from "../telegram/typing.ts";
import type { JobHandler } from "../worker.ts";
import { withFrontTurnLock } from "./lock.ts";
import type { TelegramSender } from "./reply.ts";
import { hasClaimableInput, runFrontTurn } from "./turn.ts";
import type { WindowBudget } from "./window.ts";

/**
 * The `front_turn` job: queued by the Telegram webhook, one per burst of
 * messages. Turns never overlap for a user (docs/design.md §1, §4):
 *
 * - If another turn holds the user's lock, this job ends without work. The
 *   running turn owns whatever arrived meanwhile.
 * - After a turn releases the lock, it queues a follow-up if input is still
 *   unconsumed. Checking after release means a job that found the lock busy
 *   can never leave input behind. If a turn crashes instead, its job's retry
 *   picks the input up.
 */
export function frontTurnHandler(deps: {
  gateway: ModelGateway;
  telegram: TelegramSender;
  vm: VmClient;
  runTokenSecret: string;
  blobs: BlobStore;
  timers?: Timers;
  window?: WindowBudget;
}): JobHandler {
  return async ({ job, db, logger }) => {
    const { userId } = job;
    if (!userId) throw new Error("front_turn job has no user");
    const outcome = await withFrontTurnLock(db, userId, () =>
      runFrontTurn({ ...deps, db, logger }, userId),
    );
    if (outcome === "busy") {
      logger.info(
        "another turn is running for this user; it will pick this input up",
      );
      return;
    }
    if (await hasClaimableInput(db, userId))
      await enqueue(db, frontTurnJob.type, {
        userId,
        dedupeKey: frontTurnJob.dedupeKey(userId),
      });
  };
}
