import { createServerFn } from "@tanstack/react-start";
import { issueViewerTicket } from "@winston/db/viewer-tickets";
import { webConfig } from "./config.server";
import { database } from "./db.server";
import { requireUser } from "./session.server";

/** Where the browser page's live view connects: the gateway (docs/design.md §5). */
export const getBrowserPage = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireUser();
    return {
      url: new URL("/browser/connect", webConfig().GATEWAY_PUBLIC_URL).href,
    };
  },
);

/**
 * A ticket for the page's socket, for the signed-in user: it works once,
 * within a minute, so a dropped socket asks for another. The session
 * cookie never reaches the gateway's host.
 */
export const getViewerTicket = createServerFn({ method: "POST" }).handler(
  async () => {
    const user = await requireUser();
    return { ticket: await issueViewerTicket(database(), user.id) };
  },
);
