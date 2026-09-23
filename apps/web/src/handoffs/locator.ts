import { handoffSchema } from "@winston/contracts/handoffs";

const storageKey = "winston.pending-handoff";

export function rememberHandoff(id: string | null) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The original link remains usable when browser storage is unavailable.
  }
}

export function readHandoffLocator() {
  const path = window.location.pathname;
  const direct = /^\/handoffs\/([^/]+)$/.exec(path)?.[1];
  let stored: string | null = null;
  try {
    if (path === "/") stored = sessionStorage.getItem(storageKey);
  } catch {
    // A locator never supplies authentication or provider authority.
  }
  const id = handoffSchema.shape.id.safeParse(direct ?? stored);
  if (!id.success) return null;
  rememberHandoff(id.data);
  if (!direct)
    window.history.replaceState(null, "", `/handoffs/${id.data}${window.location.search}`);
  return id.data;
}
