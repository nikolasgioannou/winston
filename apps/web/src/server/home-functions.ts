import { createServerFn } from "@tanstack/react-start";
import { retryFailedVm } from "@winston/db/vms";
import { database } from "./db.server";
import { homeState } from "./home.server";
import { requireUser } from "./session.server";

/** `/home`'s loader: the user's setup and status (docs/design.md §20). */
export const getHomeState = createServerFn({ method: "GET" }).handler(
  async () => homeState(database(), await requireUser()),
);

/** The retry button for a computer whose setup failed (§17). */
export const retryComputer = createServerFn({ method: "POST" }).handler(
  async () => ({
    retrying: await retryFailedVm(database(), (await requireUser()).id),
  }),
);
