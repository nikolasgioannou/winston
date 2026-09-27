import type { JobHandler } from "../worker.ts";
import type { ModelGateway } from "../model/gateway.ts";
import type { TelegramSender } from "./reply.ts";
import { runFrontTurn } from "./turn.ts";

/** The `front_turn` job: queued by the Telegram webhook, one per burst of messages. */
export function frontTurnHandler(deps: {
  gateway: ModelGateway;
  telegram: TelegramSender;
}): JobHandler {
  return async ({ job, db, logger }) => {
    if (!job.userId) throw new Error("front_turn job has no user");
    await runFrontTurn({ ...deps, db, logger }, job.userId);
  };
}
