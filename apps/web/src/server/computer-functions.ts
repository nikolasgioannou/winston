import { createServerFn } from "@tanstack/react-start";
import { computerStatus, retryFailedVm } from "@winston/db/vms";
import { database } from "./db.server";
import { requireUser } from "./session.server";

/**
 * How the signed-in user's computer is doing (docs/design.md §17): setting
 * up, ready, unreachable or failed. `/home` polls it while it's setting up.
 */
export const getComputerStatus = createServerFn({ method: "GET" }).handler(
  async () => computerStatus(database(), (await requireUser()).id),
);

/** The retry button for a computer whose setup failed. */
export const retryComputer = createServerFn({ method: "POST" }).handler(
  async () => ({
    retrying: await retryFailedVm(database(), (await requireUser()).id),
  }),
);
