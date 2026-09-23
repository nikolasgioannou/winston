import { readDownloadLocator, rememberDownload } from "../files/locator";
import { readHandoffLocator, rememberHandoff } from "../handoffs/locator";

const storageKey = "winston.pending-page";
const paths = ["/connections", "/schedules"];

export function rememberManagementPage() {
  try {
    if (paths.includes(window.location.pathname))
      sessionStorage.setItem(storageKey, window.location.pathname);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Direct links remain usable when browser storage is unavailable.
  }
}

export function restoreManagementPage() {
  if (paths.includes(window.location.pathname)) clearPendingDestination();
  if (readDownloadLocator() || readHandoffLocator()) return;
  const url = new URL(window.location.href);
  try {
    const saved = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    const destination = url.searchParams.has("connection_result") ? "/connections" : saved;
    if (url.pathname === "/" && destination && paths.includes(destination)) {
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
