import type {
  BrowserActionResponse,
  BrowserAutopilotResponse,
  BrowserCloseResponse,
  BrowserEvalResponse,
  BrowserScreenshotResponse,
  BrowserPageResponse,
  BrowserSnapshotResponse,
  BrowserWindowInfo,
  BrowserWindowsResponse,
} from "@winston/domain/browser";
import { call } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { resolveText, textFlag, type FlagSpec } from "../flags.ts";
import { json, list, record } from "../output.ts";

const windowFlag: FlagSpec = {
  name: "window",
  value: "<win_id>",
  description: "A window other than your current one (it must be yours)",
};

/** A window in one line: id, whose it is, then where it is. */
export function windowLine(window: BrowserWindowInfo) {
  const whose = window.mine
    ? window.current
      ? "yours, current"
      : "yours"
    : `task ${window.owner}`;
  return record(
    window.id,
    whose,
    window.openedBy ? `opened by ${window.openedBy}` : undefined,
    window.locks.length > 0 ? `holds ${window.locks.join(", ")}` : undefined,
    window.url,
    window.title ? `"${window.title}"` : undefined,
  );
}

/** What a page command did: where the window is, and what else opened. */
export function pageResult(result: BrowserPageResponse) {
  const lines = [
    record(result.window.id, result.window.title || undefined),
    `  ${result.window.url}`,
  ];
  if (!result.loaded)
    lines.push(
      "  Still loading when the wait ended; snapshot or wait before acting.",
    );
  for (const opened of result.opened)
    lines.push(
      `It opened ${opened.id} (${opened.url}), now your current window. Close it with winston browser close when you're done.`,
    );
  return lines.join("\n");
}

/** A snapshot: the window, then the page, bounded. */
export function snapshotText(result: BrowserSnapshotResponse) {
  const head = result.readOnly
    ? `Read-only peek at ${result.window.id} (task ${result.window.owner}).`
    : record(result.window.id, result.window.title || undefined);
  const lines = [head, `  ${result.window.url}`, ...result.lines];
  if (result.lines.length === 0)
    lines.push("(Nothing here yet: the page may still be loading.)");
  if (result.more > 0)
    lines.push(`… ${String(result.more)} more lines (a long page).`);
  return lines.join("\n");
}

/** What `act` did, why it stopped, and the page it ended on. */
export function actText(result: BrowserAutopilotResponse) {
  const did =
    result.actions.length > 0
      ? result.actions.map((action) => `- ${action}`)
      : ["Nothing done."];
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const escalated = result.escalated
    ? ` (${String(result.escalated)} step${result.escalated === 1 ? "" : "s"} decided by the stronger model)`
    : "";
  const at = `${result.window.url}${result.window.title ? ` ("${result.window.title}")` : ""}`;
  return [
    ...did,
    `Stopped (${result.stop}) after ${seconds} s${escalated}: ${result.reason}`,
    ...(result.page
      ? [`Now at ${at}. On screen:`, result.page.text || "(no text)"]
      : [`Now at ${at}. Snapshot to check.`]),
  ].join("\n");
}

/** What an action did, and what the agent should know before its next step. */
export function actionText(result: BrowserActionResponse) {
  const lines = [result.did];
  if (result.note) lines.push(result.note);
  if (result.navigated)
    lines.push(
      `Now at ${result.window.url}${result.window.title ? ` ("${result.window.title}")` : ""}.`,
    );
  for (const opened of result.opened)
    lines.push(
      `It opened ${opened.id} (${opened.url}), now your current window.`,
    );
  lines.push(...result.handledDialogs);
  if (result.dialog)
    lines.push(
      `The page is asking (${result.dialog.type}): "${result.dialog.message}". Answer with winston browser dialog accept or dismiss${result.dialog.type === "prompt" ? " (accept takes the text to enter)" : ""}.`,
    );
  if (!result.settled)
    lines.push(
      "The page was still changing when the wait ended; look before your next step.",
    );
  return lines.join("\n");
}

/** A duration for --timeout: `10s`, `2m`, `500ms`; at most 2 minutes. */
export function timeoutMs(value: string) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(
    value.trim().toLowerCase(),
  );
  if (!match)
    throw CliError.usage(
      `"${value}" isn't a duration.`,
      "For example 10s, 2m or 500ms.",
    );
  const n = Number(match[1]);
  const ms = match[2] === "ms" ? n : match[2] === "m" ? n * 60_000 : n * 1000;
  return Math.min(Math.max(ms, 100), 120_000);
}

const post = <T>(context: Context, route: string, body: unknown) =>
  call<T>(context.local.request("POST", `/v1/browser/${route}`, body));

export const browser: Resource = {
  name: "browser",
  description:
    "Your own Chrome window in the shared profile (logins persist): open, read, act, close",
  ids: ["win"],
  verbs: [
    {
      name: "windows",
      // Every other noun lists with `list`, so that's the natural guess.
      aliases: ["list"],
      summary: "Every agent's window: id, owner, URL and title",
      flags: [],
      examples: ["winston browser windows"],
      run: async (context) => {
        const result = await call<BrowserWindowsResponse>(
          context.local.request("GET", "/v1/browser/windows"),
        );
        if (context.flags.json === true) return json(result);
        if (result.windows.length === 0)
          return "No windows are open. winston browser open <url> opens yours.";
        return list(result.windows.map(windowLine), {
          limit: result.windows.length,
        });
      },
    },
    {
      name: "get",
      summary: "One window: owner, URL and title",
      usage: "<win_id>",
      flags: [],
      examples: ["winston browser get win_01k5…"],
      run: async (context) => {
        const [id] = context.args;
        if (!id)
          throw CliError.usage(
            "Which window? Pass a win_ id.",
            "winston browser windows lists them.",
          );
        const result = await call<{ window: BrowserWindowInfo }>(
          context.local.request("GET", `/v1/browser/windows/${id}`),
        );
        return context.flags.json === true
          ? json(result)
          : windowLine(result.window);
      },
    },
    {
      name: "open",
      summary:
        "A new window of your own (it becomes your current one), optionally at a URL",
      usage: "[<url>]",
      flags: [],
      examples: [
        "winston browser open https://www.opentable.com",
        "winston browser open",
      ],
      run: async (context) => {
        const [url] = context.args;
        const result = await post<BrowserPageResponse>(
          context,
          "open",
          url ? { url } : {},
        );
        return context.flags.json === true ? json(result) : pageResult(result);
      },
    },
    {
      name: "navigate",
      summary:
        "Go to a URL, or back or forward, in your window; waits for it to load",
      usage: "<url> | --back | --forward",
      flags: [
        { name: "back", description: "Go back a page" },
        { name: "forward", description: "Go forward a page" },
        windowFlag,
      ],
      examples: [
        "winston browser navigate https://news.ycombinator.com",
        "winston browser navigate --back",
      ],
      run: async (context) => {
        const [url] = context.args;
        const back = context.flags.back === true;
        const forward = context.flags.forward === true;
        if ([url !== undefined, back, forward].filter(Boolean).length !== 1)
          throw CliError.usage(
            "Give a URL, --back or --forward (one of them).",
            "winston browser navigate https://example.com",
          );
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserPageResponse>(context, "navigate", {
          ...(url ? { url } : back ? { back: true } : { forward: true }),
          ...(window ? { window } : {}),
        });
        return context.flags.json === true ? json(result) : pageResult(result);
      },
    },
    {
      name: "click-xy",
      summary:
        "Click at a point (screenshot pixels): the last resort, for what act can't operate (a canvas, an odd widget)",
      usage: "<x> <y>",
      flags: [windowFlag],
      examples: ["winston browser click-xy 640 360"],
      run: async (context) => {
        const [x, y] = context.args.map(Number);
        if (
          x === undefined ||
          y === undefined ||
          Number.isNaN(x) ||
          Number.isNaN(y)
        )
          throw CliError.usage(
            "Pass the point as two numbers: x then y.",
            "winston browser click-xy 640 360",
          );
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserActionResponse>(context, "click-xy", {
          x,
          y,
          ...(window ? { window } : {}),
        });
        return context.flags.json === true ? json(result) : actionText(result);
      },
    },
    {
      name: "wait",
      summary:
        "Wait for text or an element to appear, or for the page to settle",
      flags: [
        {
          name: "for",
          value: "<text>",
          description: "Text that should appear on the page",
        },
        {
          name: "timeout",
          value: "<duration>",
          description: "How long to wait (default 10s, at most 2m)",
        },
        windowFlag,
      ],
      examples: [
        'winston browser wait --for "Order confirmed"',
        'winston browser wait --for "Results" --timeout 30s',
        "winston browser wait",
      ],
      run: async (context) => {
        const target = textFlag(context.flags, "for");
        const timeout = textFlag(context.flags, "timeout");
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserActionResponse>(context, "wait", {
          ...(target ? { text: target } : {}),
          timeoutMs: timeout ? timeoutMs(timeout) : 10_000,
          ...(window ? { window } : {}),
        });
        return context.flags.json === true ? json(result) : actionText(result);
      },
    },
    {
      name: "dialog",
      summary: "Answer the page's confirm or prompt dialog",
      usage: "accept [<text>] | dismiss",
      flags: [windowFlag],
      examples: [
        "winston browser dialog accept",
        "winston browser dialog dismiss",
        'winston browser dialog accept "Ada"',
      ],
      run: async (context) => {
        const [answer, ...rest] = context.args;
        if (answer !== "accept" && answer !== "dismiss")
          throw CliError.usage(
            "Answer with accept or dismiss.",
            "winston browser dialog accept",
          );
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserActionResponse>(context, "dialog", {
          accept: answer === "accept",
          ...(rest.length > 0 ? { text: rest.join(" ") } : {}),
          ...(window ? { window } : {}),
        });
        return context.flags.json === true ? json(result) : actionText(result);
      },
    },
    {
      name: "screenshot",
      summary:
        "Save a PNG of the window and print its path (look at it with view_image)",
      flags: [
        {
          name: "full-page",
          description: "The whole page, not just what's in view",
        },
        {
          name: "window",
          value: "<win_id>",
          description: "Another run's window, to look at",
        },
      ],
      examples: [
        "winston browser screenshot",
        "winston browser screenshot --full-page",
      ],
      run: async (context) => {
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserScreenshotResponse>(
          context,
          "screenshot",
          {
            ...(window ? { window } : {}),
            fullPage: context.flags["full-page"] === true,
          },
        );
        if (context.flags.json === true) return json(result);
        return [
          `Saved ${result.path} (${String(result.width)}×${String(result.height)}${result.fullPage ? ", full page" : ""}).`,
          result.clipped
            ? "The page is taller than that; the rest was cut off."
            : undefined,
          "Look at it with view_image.",
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      name: "eval",
      summary:
        "Run JavaScript in your window's page and print the result as JSON (text, - or @path)",
      usage: "<js>",
      flags: [
        {
          name: "page-world",
          description:
            "Run among the page's own scripts, to reach their variables (they can see it there)",
        },
        windowFlag,
      ],
      examples: [
        "winston browser eval 'document.title'",
        "winston browser eval '[...document.querySelectorAll(\"h2 a\")].map(a => ({ text: a.innerText, href: a.href }))'",
        "winston browser eval @extract.js",
      ],
      run: async (context) => {
        const raw = context.args.join(" ");
        if (!raw)
          throw CliError.usage(
            "What should run? Pass JavaScript, - for stdin, or @path.",
            "winston browser eval 'document.title'",
          );
        const code = await resolveText(raw, context.text);
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserEvalResponse>(context, "eval", {
          code,
          pageWorld: context.flags["page-world"] === true,
          ...(window ? { window } : {}),
        });
        if (context.flags.json === true) return json(result);
        return result.more > 0
          ? `${result.value}\n… ${String(result.more)} more characters. Return less: filter or slice in the script.`
          : result.value;
      },
    },
    {
      name: "act",
      summary:
        "Do something on the page, a whole flow with every value it needs or one step: a fast model drives and a stronger one takes the steps it's unsure of; it stops when done, blocked, short of a value, or before anything that commits",
      usage: "<instruction>",
      flags: [
        {
          name: "max-steps",
          value: "<n>",
          description: "At most this many actions (default 30, at most 60)",
        },
        {
          name: "max-seconds",
          value: "<n>",
          description: "Stop after this long (default 30, at most 120)",
        },
        {
          name: "commit",
          description:
            "The user said yes to what this commits (a submit, send, booking or payment): take that one step, then stop",
        },
        windowFlag,
      ],
      examples: [
        'winston browser act "search flights from Zurich to London, one way, on 2026-11-20, one adult"',
        'winston browser act "click New request"',
        'winston browser act "click Submit request" --commit',
        "winston browser act \"fill in the request: category Plumbing, description 'the shower drains slowly'; don't submit\" --max-seconds 60",
      ],
      run: async (context) => {
        const goal = context.args.join(" ").trim();
        if (!goal)
          throw CliError.usage(
            "What should it do? Say it with every value it needs.",
            "winston browser act \"search for 'dune' and open the first result\"",
          );
        const whole = (name: string) => {
          const raw = textFlag(context.flags, name);
          const value = raw === undefined ? undefined : Number(raw);
          if (value !== undefined && (!Number.isInteger(value) || value < 1))
            throw CliError.usage(
              `--${name} takes a whole number, like 20.`,
              `winston browser act "open the first result" --${name} 20`,
            );
          return value;
        };
        const maxSteps = whole("max-steps");
        const maxSeconds = whole("max-seconds");
        const window = textFlag(context.flags, "window");
        // The route keeps autopilot's name, which daemons not yet updated know.
        const result = await post<BrowserAutopilotResponse>(
          context,
          "autopilot",
          {
            goal,
            ...(maxSteps ? { maxSteps } : {}),
            ...(maxSeconds ? { maxSeconds } : {}),
            ...(context.flags.commit === true ? { commit: true } : {}),
            ...(window ? { window } : {}),
          },
        );
        return context.flags.json === true ? json(result) : actText(result);
      },
    },
    {
      name: "snapshot",
      summary:
        "What's on the page, to read: its structure and controls (--full adds its text)",
      flags: [
        {
          name: "full",
          description:
            "Include the page's text, not just its structure and controls",
        },
        {
          name: "window",
          value: "<win_id>",
          description: "Another run's window, to look at (read-only)",
        },
      ],
      examples: [
        "winston browser snapshot",
        "winston browser snapshot --full",
        "winston browser snapshot --window win_01k5…",
      ],
      run: async (context) => {
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserSnapshotResponse>(
          context,
          "snapshot",
          {
            ...(window ? { window } : {}),
            full: context.flags.full === true,
          },
        );
        return context.flags.json === true
          ? json(result)
          : snapshotText(result);
      },
    },
    {
      name: "close",
      summary: "Close your current window (or --window); others stay open",
      flags: [windowFlag],
      examples: [
        "winston browser close",
        "winston browser close --window win_01k5…",
      ],
      run: async (context) => {
        const window = textFlag(context.flags, "window");
        const result = await post<BrowserCloseResponse>(
          context,
          "close",
          window ? { window } : {},
        );
        if (context.flags.json === true) return json(result);
        return result.current
          ? `Closed ${result.closed}. Your current window is now ${result.current}.`
          : `Closed ${result.closed}. You have no other window.`;
      },
    },
  ],
};
