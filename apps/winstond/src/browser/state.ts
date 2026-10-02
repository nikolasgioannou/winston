/**
 * What the browser's parts share: the failure type commands report, the
 * timings, and a window's state in winstond's registry.
 */
import type { ApiErrorCode } from "@winston/domain/api-errors";
import type { RefTarget } from "./snapshot.ts";

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
  /** Refs from the owner's last snapshot, valid until the next. */
  refs: Map<string, RefTarget>;
  /** Every ref given in this window, by node, so a node keeps its ref. */
  refByNode: Map<string, string>;
  nextRef: number;
  /** When a request last started or ended in the page (for settling). */
  lastNetwork: number;
  /** Frames still loading a document. */
  loadingFrames: Set<string>;
  /** A confirm or prompt waiting for an answer. */
  dialog?: OpenDialog | undefined;
  /** Alerts and leave-page prompts accepted since the last action. */
  handledDialogs: string[];
  /** Isolated worlds for looking at the page, by session and frame. */
  worlds: Map<string, number>;
  /** Handed to the user (a handoff): the agent can't act in it. */
  heldForUser: boolean;
}
