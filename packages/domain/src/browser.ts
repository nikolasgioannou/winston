/**
 * `winston browser` over winstond's unix socket (docs/design.md §5 Browser,
 * §11): the CLI is short-lived, so winstond holds the CDP connection and the
 * window registry, and answers these calls itself (they never reach the
 * backend). Errors use the API error body, so exit codes match the rest of
 * the CLI.
 */

/** Paths under winstond's socket that it answers locally. */
export const browserPathPrefix = "/v1/browser/";

/** One agent window in the shared profile. */
export interface BrowserWindowInfo {
  /** `win_…`. */
  id: string;
  /** The run that owns it: `front` for the front of house, else a run id. */
  owner: string;
  url: string;
  title: string;
  /** The window that opened it (`window.open`, `target=_blank`), if any. */
  openedBy: string | null;
  /** Whether it's the caller's current window (where commands act). */
  current: boolean;
  /** Whether the caller owns it. */
  mine: boolean;
}

export interface BrowserWindowsResponse {
  windows: BrowserWindowInfo[];
}

export interface BrowserOpenRequest {
  url?: string;
}

export type BrowserNavigateRequest = (
  { url: string } | { back: true } | { forward: true }
) & { window?: string };

export interface BrowserCloseRequest {
  window?: string;
}

/** What a command that may load a page answers. */
export interface BrowserPageResponse {
  window: BrowserWindowInfo;
  /** False when the page was still loading at the wait's end. */
  loaded: boolean;
  /** Windows the page opened meanwhile; the newest became current. */
  opened: BrowserWindowInfo[];
}

export interface BrowserCloseResponse {
  closed: string;
  /** The caller's current window afterwards, if it has another. */
  current: string | null;
}

export interface BrowserSnapshotRequest {
  window?: string;
  full?: boolean;
}

export interface BrowserSnapshotResponse {
  window: BrowserWindowInfo;
  /** The page as indented lines; refs look like `[e3]`. */
  lines: string[];
  /** Lines left out to keep the output bounded. */
  more: number;
  /** A peek at another run's window: no refs, nothing to act on. */
  readOnly: boolean;
}
