import type {
  BrowserCloseResponse,
  BrowserPageResponse,
  BrowserWindowInfo,
  BrowserWindowsResponse,
} from "@winston/domain/browser";
import { call } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { textFlag, type FlagSpec } from "../flags.ts";
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

const post = <T>(context: Context, route: string, body: unknown) =>
  call<T>(context.local.request("POST", `/v1/browser/${route}`, body));

export const browser: Resource = {
  name: "browser",
  description:
    "Your own Chrome window in the shared profile (logins persist): open, navigate, close",
  ids: ["win"],
  verbs: [
    {
      name: "windows",
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
