import { readDownloadLocator, rememberDownload } from "../files/locator";
import { readHandoffLocator, rememberHandoff } from "../handoffs/locator";
import { scheduleSchema } from "@winston/contracts/schedules";

const storageKey = "winston.pending-page";
const paths = ["/connections", "/computers", "/schedules", "/responsibilities"];
function allowedPath(path: string) {
  if (paths.includes(path)) return true;
  const id =
    /^\/schedules\/([^/]+)(?:\/runs)?$/.exec(path)?.[1] ??
    /^\/responsibilities\/([^/]+)$/.exec(path)?.[1];
  return scheduleSchema.shape.id.safeParse(id).success;
}

export function rememberManagementPage() {
  try {
    if (allowedPath(window.location.pathname))
      sessionStorage.setItem(storageKey, window.location.pathname);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Direct links remain usable when browser storage is unavailable.
  }
}

export function restoreManagementPage() {
  if (allowedPath(window.location.pathname)) clearPendingDestination();
  if (readDownloadLocator() || readHandoffLocator()) return;
  const url = new URL(window.location.href);
  try {
    const saved = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    const destination = url.searchParams.has("connection_result") ? "/connections" : saved;
    if (url.pathname === "/" && destination && allowedPath(destination)) {
      window.history.replaceState(null, "", `${destination}${url.search}`);
    }
  } catch {
    // Restoring a destination never authorizes access to it.
  }
}

export function clearPendingDestination() {
  rememberDownload(null);
  rememberHandoff(null);
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Navigation works without storage.
  }
}
