import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { sidebarWidthCookie } from "../components/sidebar-width";
import { currentUser } from "./session.server";

/**
 * The signed-in user, or null: for route guards. It only protects pages;
 * every private server function must check the session itself too.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async () => (await currentUser()) ?? null,
);

/**
 * What the app shell needs before it renders: the user, and the sidebar
 * width they chose, read from its cookie so the page arrives at that width.
 */
export const getShellState = createServerFn({ method: "GET" }).handler(
  async () => {
    const width = Number(getCookie(sidebarWidthCookie));
    return {
      user: (await currentUser()) ?? null,
      sidebarWidth: Number.isFinite(width) && width > 0 ? width : undefined,
    };
  },
);
