import { readDownloadLocator, rememberDownload } from "../files/locator";
import { readHandoffLocator, rememberHandoff } from "../handoffs/locator";

const storageKey = "winston.pending-page";

export function rememberManagementPage() {
  try {
    if (window.location.pathname === "/connections")
      sessionStorage.setItem(storageKey, "/connections");
    else sessionStorage.removeItem(storageKey);
  } catch {
    // Direct links remain usable when browser storage is unavailable.
  }
}

export function restoreManagementPage() {
  if (window.location.pathname === "/connections") clearPendingDestination();
  if (readDownloadLocator() || readHandoffLocator()) return;
  const url = new URL(window.location.href);
  try {
    const saved = sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    if (
      url.pathname === "/" &&
      (saved === "/connections" || url.searchParams.has("connection_result"))
    ) {
      window.history.replaceState(null, "", `/connections${url.search}`);
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
