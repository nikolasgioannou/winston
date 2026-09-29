import { createServerFn } from "@tanstack/react-start";
import { currentUser } from "./session.server";

/**
 * The signed-in user, or null: for route guards. It only protects pages;
 * every private server function must check the session itself too.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async () => (await currentUser()) ?? null,
);
