/**
 * What the browser's parts share: the failure type commands report, the
 * timings, and a window's state in winstond's registry.
 */
import type { ApiErrorCode } from "@winston/domain/api-errors";

/** A browser command that can't be done, as the CLI should report it. */
export class BrowserFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "BrowserFailure";
  }
}

export const browserTimings = {
  /** How long a navigation waits for the page's load event. */
  loadTimeoutMs: 30_000,
  /** After load, how long it waits for the network to quiet down. */
  settleMs: 2_000,
  /** Snapshot lines shown, by default and with --full. */
  snapshotLines: 300,
  fullSnapshotLines: 600,
  /** A window unused this long, whose run's last token has expired, is closed. */
  idleMs: 30 * 60_000,
};

/** A JavaScript dialog the page is waiting on (confirm, prompt). */
export interface OpenDialog {
  type: string;
  message: string;
  defaultPrompt: string;
}

/**
 * A file picker the page opened (a click on an upload control). Chrome's
 * own picker is never shown: the files come from `winston browser upload`.
 */
export interface OpenFileChooser {
  /** Whether the input takes several files. */
  multiple: boolean;
  /** The `<input type="file">` and the session (page or frame) it's in. */
  backendNodeId: number;
  sessionId: string;
}

export interface WindowEntry {
  id: string;
  targetId: string;
  owner: string;
  openedBy: string | null;
  url: string;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  /** The flat CDP session, once attached. */
  sessionId?: string;
  /** Cross-site frames' sessions (auto-attached), by target id. */
  frames: Map<string, string>;
  /** When a request last started or ended in the page (for settling). */
  lastNetwork: number;
  /**
   * Whether the window's own document is loading. Frames inside it don't
   * count: a widget whose frame never finishes would hold every action.
   */
  loading: boolean;
  /** A confirm or prompt waiting for an answer, and the session (page or frame) it's in. */
  dialog?: (OpenDialog & { sessionId: string }) | undefined;
  /** A file picker waiting for files (`upload`). */
  fileChooser?: OpenFileChooser | undefined;
  /** Alerts and leave-page prompts accepted since the last action. */
  handledDialogs: string[];
  /** Isolated worlds for looking at the page, by session and frame. */
  worlds: Map<string, number>;
  /**
   * The person has it, handed over by the agent (`handoff`) or taken over
   * from the browser page (`takeover`): the agent can't act in it.
   */
  heldForUser: "handoff" | "takeover" | null;
}
