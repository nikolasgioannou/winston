import { newFrameId, type ExecResult } from "@winston/domain/frames";

/** An error the gateway reported, with its code (`vm_unavailable`, `vm_unreachable`, …). */
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What agents need from a user's VM, through the gateway's internal API (docs/design.md §15). */
export interface VmClient {
  exec(
    userId: string,
    request: {
      /** The command's id; the same id never runs twice. One is made when it's left out. */
      id?: string;
      cmd: string;
      cwd?: string;
      env: Record<string, string>;
      timeoutMs: number;
    },
  ): Promise<ExecResult>;
  /** A command's result by id without running it, or undefined if the VM has no record of it. */
  fetchExec(userId: string, execId: string): Promise<ExecResult | undefined>;
  writeFile(userId: string, path: string, bytes: Uint8Array): Promise<void>;
  readFile(userId: string, path: string): Promise<Uint8Array>;
  /**
   * Holds a run's current browser window for the user (browser handoff);
   * null when it has none. `owner` is `front` or the run id.
   */
  holdBrowser(
    userId: string,
    owner: string,
  ): Promise<{ windowId: string; targetId: string; url: string } | null>;
  /** Lets a run's held windows go and ends their live views. */
  releaseBrowser(userId: string, owner: string): Promise<void>;
}

/**
 * How long a call keeps retrying, from its first failure, while the VM is
 * momentarily unavailable: winstond restarting after an update (systemd waits
 * 2 s) or reconnecting to another gateway.
 */
export const vmRetry = { forMs: 30_000, everyMs: 2_000 };

export function gatewayClient({
  baseUrl,
  secret,
  locate,
  sleep = Bun.sleep,
}: {
  baseUrl: string;
  secret: string;
  /**
   * The gateway holding a user's VM (recorded by the gateway itself), so a
   * call reaches the one with the connection while a deploy runs two.
   * Falls back to `baseUrl`.
   */
  locate?: (userId: string) => Promise<string | null | undefined>;
  sleep?: (ms: number) => Promise<unknown>;
}): VmClient {
  const headers = { Authorization: `Bearer ${secret}` };

  const failure = async (response: Response) => {
    const body = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    return new GatewayError(
      body?.error?.code ?? "gateway_error",
      body?.error?.message ??
        `The gateway answered ${String(response.status)}.`,
    );
  };

  /**
   * Calls the gateway holding the user's VM. A VM that's momentarily away
   * (a gateway deploy, winstond restarting after an update) is retried for
   * a little while before the failure counts: a VM call is safe to repeat
   * (an exec with the same id never runs twice). A long command cut off
   * near its end gets the whole window too.
   */
  async function request(userId: string, path: string, init: RequestInit = {}) {
    let deadline: number | undefined;
    // A recorded gateway that can't be reached (gone, or a wrong address)
    // isn't trusted for the next attempt: the shared name is tried instead.
    let skipLocated = false;
    for (;;) {
      const located: string | null | undefined = skipLocated
        ? undefined
        : await locate?.(userId).catch(() => undefined);
      const base: string = located ?? baseUrl;
      let response: Response | undefined;
      try {
        response = await fetch(new URL(path, base).href, {
          ...init,
          headers: {
            ...headers,
            ...(init.headers as Record<string, string> | undefined),
          },
        });
      } catch {
        response = undefined;
      }
      skipLocated = !response && Boolean(located);
      const away = !response || response.status === 409;
      deadline ??= Date.now() + vmRetry.forMs;
      if (!away || Date.now() >= deadline) {
        if (!response)
          throw new GatewayError(
            "gateway_unreachable",
            "The gateway isn't reachable.",
          );
        return response;
      }
      await sleep(vmRetry.everyMs);
    }
  }

  const json = { "Content-Type": "application/json" };

  return {
    async holdBrowser(userId, owner) {
      const response = await request(
        userId,
        `/internal/vms/${userId}/browser/hold`,
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ owner }),
        },
      );
      if (!response.ok) throw await failure(response);
      return (
        (
          (await response.json()) as {
            window?: { windowId: string; targetId: string; url: string } | null;
          }
        ).window ?? null
      );
    },
    async releaseBrowser(userId, owner) {
      const response = await request(
        userId,
        `/internal/vms/${userId}/browser/release`,
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ owner }),
        },
      );
      if (!response.ok) throw await failure(response);
    },
    async exec(userId, request_) {
      const response = await request(userId, `/internal/vms/${userId}/exec`, {
        method: "POST",
        headers: json,
        // The id makes a retry after a cut-off join or report the first run.
        body: JSON.stringify({ ...request_, id: request_.id ?? newFrameId() }),
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as ExecResult;
    },
    async fetchExec(userId, execId) {
      const response = await request(
        userId,
        `/internal/vms/${userId}/execs/${encodeURIComponent(execId)}`,
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return (await response.json()) as ExecResult;
    },
    async writeFile(userId, path, bytes) {
      const response = await request(
        userId,
        `/internal/vms/${userId}/files?path=${encodeURIComponent(path)}`,
        { method: "PUT", body: bytes },
      );
      if (!response.ok) throw await failure(response);
    },
    async readFile(userId, path) {
      const response = await request(
        userId,
        `/internal/vms/${userId}/files?path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
