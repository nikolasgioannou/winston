import { createServerFn } from "@tanstack/react-start";
import { webConfig } from "./config.server";

/**
 * Where a handoff page's live view connects. Public on purpose: the page
 * needs no sign-in, and the token it carries is checked by the gateway.
 */
export const getLiveViewUrl = createServerFn({ method: "GET" }).handler(
  () => new URL("/handoff/connect", webConfig().GATEWAY_PUBLIC_URL).href,
);
