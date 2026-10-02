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
  /** Websites its run holds the lock for, acting from this window. */
  locks: string[];
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

/** What an action (click, type, select, press, scroll, wait) answers. */
export interface BrowserActionResponse {
  /** What was done: `Clicked e5 (button "Sign in").` */
  did: string;
  /** Anything worth knowing about how it went. */
  note?: string;
  window: BrowserWindowInfo;
  /** Whether the window's URL changed. */
  navigated: boolean;
  /** False when the page was still busy when the wait ended. */
  settled: boolean;
  /** Windows the page opened meanwhile; the newest became current. */
  opened: BrowserWindowInfo[];
  /** A confirm or prompt waiting for an answer (browser dialog). */
  dialog: { type: string; message: string; defaultPrompt: string } | null;
  /** Alerts and leave-page prompts answered automatically. */
  handledDialogs: string[];
}

export interface BrowserScreenshotResponse {
  window: BrowserWindowInfo;
  /** Where the PNG was saved on the VM, for view_image. */
  path: string;
  width: number;
  height: number;
  fullPage: boolean;
  /** A full page cut short at the height limit. */
  clipped: boolean;
}

export interface BrowserEvalResponse {
  window: BrowserWindowInfo;
  /** The result as JSON (`undefined` when there's none), maybe cut short. */
  value: string;
  /** Characters left out to keep the output bounded. */
  more: number;
}
