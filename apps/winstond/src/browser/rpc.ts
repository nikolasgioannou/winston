/**
 * The browser's calls on winstond's socket (`/v1/browser/…`), answered here
 * rather than forwarded to the backend (docs/design.md §15).
 */
import { apiError, apiErrors } from "@winston/domain/api-errors";
import { browserPathPrefix } from "@winston/domain/browser";
import type { RpcMethod, RpcResponse } from "../daemon.ts";
import { CdpError } from "./cdp.ts";
import { BrowserFailure, type Browser } from "./windows.ts";

const reply = (status: number, value: unknown): RpcResponse => ({
  status,
  body: JSON.stringify(value),
});

const failure = (error: BrowserFailure) =>
  reply(
    apiErrors[error.code].status,
    apiError(error.code, error.message, error.hint),
  );

export function isBrowserPath(path: string) {
  return path.startsWith(browserPathPrefix);
}

export function browserRpc(browser: Browser) {
  return async (request: {
    method: RpcMethod;
    path: string;
    body: string | null;
    runToken: string;
  }): Promise<RpcResponse> => {
    const route = request.path.slice(browserPathPrefix.length).split("?")[0];
    let body: Record<string, unknown> = {};
    try {
      body = request.body
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : {};
    } catch {
      return failure(
        new BrowserFailure("invalid_request", "That request isn't JSON."),
      );
    }
    const text = (name: string) =>
      typeof body[name] === "string" ? body[name] : undefined;
    try {
      if (request.method === "GET" && route === "windows")
        return reply(200, { windows: await browser.windows(request.runToken) });
      const one = /^windows\/([^/]+)$/.exec(route ?? "");
      if (request.method === "GET" && one?.[1])
        return reply(200, {
          window: await browser.window(request.runToken, one[1]),
        });
      if (request.method === "POST" && route === "open")
        return reply(200, await browser.open(request.runToken, text("url")));
      if (request.method === "POST" && route === "navigate")
        return reply(
          200,
          await browser.navigate(
            request.runToken,
            {
              ...(text("url") ? { url: text("url") } : {}),
              back: body.back === true,
              forward: body.forward === true,
            },
            text("window"),
          ),
        );
      if (request.method === "POST" && route === "snapshot")
        return reply(
          200,
          await browser.snapshot(request.runToken, {
            window: text("window"),
            full: body.full === true,
          }),
        );
      if (request.method === "POST" && route === "close")
        return reply(
          200,
          await browser.close(request.runToken, text("window")),
        );
      return failure(
        new BrowserFailure(
          "not_found",
          `There's no ${request.method} ${request.path}.`,
        ),
      );
    } catch (error) {
      if (error instanceof BrowserFailure) return failure(error);
      if (error instanceof CdpError)
        return failure(
          new BrowserFailure(
            "unavailable",
            `Chrome isn't answering (${error.message}).`,
            "It restarts by itself; try again in a minute.",
          ),
        );
      throw error;
    }
  };
}
