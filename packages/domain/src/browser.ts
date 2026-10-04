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
  /** The page as indented lines, for reading. */
  lines: string[];
  /** Lines left out to keep the output bounded. */
  more: number;
  /** A peek at another run's window. */
  readOnly: boolean;
}

/** What a coordinate click, a wait or a dialog answer answers. */
export interface BrowserActionResponse {
  /** What was done: `Clicked at (120, 340).` */
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

/** Why `winston browser act` stopped (docs/design.md §5, Jev fast path). */
export type AutopilotStop =
  /** The instruction is visibly done; the agent checks. */
  | "done"
  /** Nothing it can do makes progress (a sign-in, a bot check, something it can't operate). */
  | "blocked"
  /** Three actions in a row changed nothing. */
  | "no_progress"
  /** The next step would place an order, pay, send, book or delete. */
  | "commits"
  /** It took the one committing step `--commit` allowed; the agent checks. */
  | "committed"
  /** A field needs a value the instruction doesn't give. */
  | "needs_value"
  | "max_steps"
  | "max_time"
  /** Neither Jev nor the step picker could decide. */
  | "unavailable"
  | "failed";

/** What `winston browser act` answers. */
export interface BrowserAutopilotResponse {
  /** What it did, in order: `Clicked [3] Search.` */
  actions: string[];
  stop: AutopilotStop;
  /** Why it stopped, for the agent: `The next step would commit something: [9] Place order.` */
  reason: string;
  window: BrowserWindowInfo;
  /** How long it ran. */
  elapsedMs: number;
  /** Steps the step picker decided because Jev wasn't sure (absent from older daemons). */
  escalated?: number;
  /** The page it ended on, so checking needs no snapshot (absent from older daemons). */
  page?: { title: string; url: string; text: string };
}

/** A window as the signed-in browser page shows it (docs/design.md §5). */
export interface BrowserPageWindow {
  id: string;
  /** `front` for the conversation's own browsing, else the task's id. */
  owner: string;
  /** The start of the task's brief; null for the conversation's window. */
  task: string | null;
  title: string;
  url: string;
  /** The person has it: handed over by Winston, or taken over. */
  held: "handoff" | "takeover" | null;
  /** What Winston needs them to do, while it's handed over. */
  reason: string | null;
  /** Who has control while the person has it: this page, or another. */
  control: "you" | "elsewhere" | null;
  lastUsedAt: number;
}
