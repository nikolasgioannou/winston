/**
 * Autopilot, the Jev fast path (docs/design.md §5): routine clicking toward
 * a sub-goal ("open the first result"), decided by Jev instead of an Opus
 * turn. Each step snapshots the page and asks Jev three typed questions
 * through the backend: which element to act on, whether the sub-goal is
 * met, and whether it's stuck. It clicks only when Jev is confident, and
 * hands back to the agent when it isn't, when text needs typing, when the
 * next click looks like it commits something, or at the step limit.
 *
 * Whether the picks were right is the agent's next move in that window
 * (`observe`): going back overrides them, anything else keeps them. Sites
 * where Jev keeps being overridden get no autopilot.
 */
import type {
  AutopilotStop,
  BrowserActionResponse,
  BrowserAutopilotResponse,
  BrowserSnapshotResponse,
  BrowserWindowInfo,
} from "@winston/domain/browser";
import type { RpcMethod, RpcResponse } from "../daemon.ts";
import { lockDomain } from "./locks.ts";
import { ownerOf } from "./windows.ts";

export const autopilotLimits = {
  defaultSteps: 8,
  maxSteps: 20,
  /** Jev's choices are bounded at 255 options. */
  maxOptions: 255,
  /** Page text sent to Jev, in characters. */
  maxPage: 40_000,
  /** P(sub-goal met) at which it stops: done. */
  goalMet: 0.85,
  /** P(stuck) at which it stops, from the third step on. */
  stuck: 0.7,
  /** The picked element's probability below which it hands back. */
  confident: 0.5,
};

/** Elements a click acts on. */
const clickable = new Set([
  "link",
  "button",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "radio",
  "switch",
  "option",
  "treeitem",
]);
/** Elements that need text or a choice typed in: Jev can't. */
const typed = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);

/**
 * Names that commit something: placing an order, paying, sending, booking,
 * deleting, agreeing. Conservative on purpose (a wrong stop costs an Opus
 * turn; a wrong click can cost money), but moving toward a checkout page
 * isn't a commitment, so "Checkout" alone doesn't count.
 */
const commits =
  /\b(place (your )?order|order now|buy|purchase|pay|checkout and pay|complete (purchase|order|booking)|confirm|submit|send|book|reserve|delete|remove|discard|cancel|unsubscribe|subscribe|sign ?up|register|create account|post|publish|reply|transfer|donate|apply|accept|agree|allow|authori[sz]e|save|sign ?out|log ?out|upload|share)\b/i;

export function commitsSomething(role: string, name: string) {
  return (
    (role === "button" || role === "link" || role === "menuitem") &&
    commits.test(name)
  );
}

export interface Candidate {
  ref: string;
  role: string;
  name: string;
  /** How the snapshot shows it: `link "Bun"`. */
  label: string;
}

/** The elements with refs in a snapshot, in page order. */
export function candidatesIn(lines: string[]): Candidate[] {
  const found: Candidate[] = [];
  for (const line of lines) {
    const match = /^\s*([A-Za-z]+)(?: "((?:[^"\\]|\\.)*)")? \[(e\d+)\]/.exec(
      line,
    );
    if (!match?.[1] || !match[3]) continue;
    const role = match[1];
    if (!clickable.has(role) && !typed.has(role)) continue;
    const name = match[2] ?? "";
    found.push({
      ref: match[3],
      role,
      name,
      label: name ? `${role} "${name}"` : role,
    });
  }
  return found.slice(0, autopilotLimits.maxOptions);
}

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
}
interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface AutopilotDeps {
  snapshot: (
    runToken: string,
    window: string | undefined,
  ) => Promise<BrowserSnapshotResponse>;
  click: (
    runToken: string,
    ref: string,
    window: string | undefined,
  ) => Promise<BrowserActionResponse>;
  /** A call to the backend through the gateway (the Jev routes). */
  backend: (request: {
    method: RpcMethod;
    path: string;
    body: string | null;
    runToken: string;
  }) => Promise<RpcResponse>;
}

export function createAutopilot(deps: AutopilotDeps) {
  /** Each run's last autopilot picks, waiting for its next move to judge them. */
  const pending = new Map<string, { id: string; action: string | null }[]>();

  const post = (runToken: string, path: string, body: unknown) =>
    deps.backend({
      method: "POST",
      path,
      body: JSON.stringify(body),
      runToken,
    });

  function record(
    runToken: string,
    decisions: { id: string; action: string | null }[],
    outcome: "verified" | "overridden",
  ) {
    if (decisions.length === 0) return;
    // Best effort: a lost outcome only leaves a decision `unknown`.
    void post(runToken, "/v1/jev/outcome", { decisions, outcome }).catch(
      () => undefined,
    );
  }

  return {
    async run(
      runToken: string,
      request: { goal: string; maxSteps?: number; window?: string | undefined },
    ): Promise<BrowserAutopilotResponse> {
      const { owner } = ownerOf(runToken);
      const maxSteps = Math.min(
        Math.max(
          Math.trunc(request.maxSteps ?? autopilotLimits.defaultSteps),
          1,
        ),
        autopilotLimits.maxSteps,
      );
      const actions: string[] = [];
      const decisions: { id: string; action: string | null }[] = [];
      let window: BrowserWindowInfo;
      const done = (stop: AutopilotStop, reason: string) => {
        // A run that clicked something is judged by what the agent does next.
        if (decisions.some((d) => d.action)) pending.set(owner, decisions);
        else record(runToken, decisions, "verified");
        return {
          actions,
          stop,
          reason,
          window,
        };
      };

      let snap = await deps.snapshot(runToken, request.window);
      window = snap.window;
      const domain = lockDomain(snap.window.url);
      if (domain) {
        const site = await deps.backend({
          method: "GET",
          path: `/v1/jev/sites/${encodeURIComponent(domain)}`,
          body: null,
          runToken,
        });
        if (
          site.status === 200 &&
          !(JSON.parse(site.body) as { reliable: boolean }).reliable
        )
          return done(
            "unreliable",
            `Autopilot isn't reliable on ${domain}; drive it directly.`,
          );
      }

      for (let step = 1; ; step++) {
        const candidates = candidatesIn(snap.lines);
        if (candidates.length === 0)
          return done("unsure", "Nothing on the page to act on.");
        const reply = await post(runToken, "/v1/jev/decide", {
          domain,
          state: {
            goal: request.goal,
            url: snap.window.url,
            title: snap.window.title,
            done_so_far: actions,
            page: snap.lines.join("\n").slice(0, autopilotLimits.maxPage),
          },
          questions: {
            action: {
              type: "choice",
              instructions:
                "Which single element should be acted on next to advance the goal on this page?",
              criteria: Object.fromEntries(
                candidates.map((c) => [c.ref, c.label]),
              ),
            },
            goal_done: {
              type: "noul",
              instructions:
                "The goal has been achieved: the current page shows the sought destination or outcome.",
            },
            stuck: {
              type: "noul",
              instructions:
                "The steps so far aren't making progress toward the goal (repeats, loops, or no change).",
            },
          },
        });
        if (reply.status !== 200)
          return done(
            "unavailable",
            "Jev isn't available right now; drive the page directly.",
          );
        const answer = JSON.parse(reply.body) as {
          decisionId: string;
          answers: {
            action: ChoiceAnswer;
            goal_done: NoulAnswer;
            stuck: NoulAnswer;
          };
        };
        const decision = {
          id: answer.decisionId,
          action: null as string | null,
        };
        decisions.push(decision);
        const { action, goal_done, stuck } = answer.answers;
        if (goal_done.noul >= autopilotLimits.goalMet)
          return done("goal_met", "The sub-goal looks met.");
        if (step > 2 && stuck.noul >= autopilotLimits.stuck)
          return done("stuck", "It isn't making progress.");
        const pick = candidates.find((c) => c.ref === action.choice);
        if (
          !pick ||
          (action.probabilities[action.choice] ?? 0) < autopilotLimits.confident
        )
          return done("unsure", "Jev wasn't sure what to do next.");
        if (typed.has(pick.role))
          return done(
            "needs_typing",
            `The next step needs typing into ${pick.ref} (${pick.label}).`,
          );
        if (commitsSomething(pick.role, pick.name))
          return done(
            "commits",
            `The next step commits something: ${pick.ref} (${pick.label}). Decide it yourself.`,
          );
        let clicked: BrowserActionResponse;
        try {
          clicked = await deps.click(runToken, pick.ref, request.window);
        } catch (error) {
          return done(
            "failed",
            `Clicking ${pick.ref} (${pick.label}) failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
        decision.action = `click ${pick.ref} (${pick.label})`;
        actions.push(clicked.did);
        window = clicked.window;
        if (step >= maxSteps)
          return done("max_steps", `Stopped after ${String(maxSteps)} steps.`);
        snap = await deps.snapshot(runToken, request.window);
        window = snap.window;
      }
    },

    /**
     * The agent acted again: its last autopilot picks were right unless it
     * went back.
     */
    observe(runToken: string, route: string, body: Record<string, unknown>) {
      const { owner } = ownerOf(runToken);
      const last = pending.get(owner);
      if (!last) return;
      pending.delete(owner);
      const wentBack = route === "navigate" && body.back === true;
      record(runToken, last, wentBack ? "overridden" : "verified");
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
