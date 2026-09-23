import { artifactSchema } from "@winston/contracts/artifacts";
import { rememberHandoff } from "../handoffs/locator";

const storageKey = "winston.pending-download";

export function rememberDownload(id: string | null) {
  try {
    if (id) sessionStorage.setItem(storageKey, id);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The original link remains usable without browser storage.
  }
}

export function readDownloadLocator() {
  const path = window.location.pathname;
  if (path.startsWith("/handoffs/")) {
    rememberDownload(null);
    return null;
  }
  const direct = /^\/files\/([^/]+)$/.exec(path)?.[1];
  let stored: string | null = null;
  try {
    if (path === "/") stored = sessionStorage.getItem(storageKey);
  } catch {
    // A locator does not authorize access.
  }
  const id = artifactSchema.shape.id.safeParse(direct ?? stored);
  if (!id.success) return null;
  rememberHandoff(null);
  rememberDownload(id.data);
  if (!direct) window.history.replaceState(null, "", `/files/${id.data}`);
  return id.data;
}
