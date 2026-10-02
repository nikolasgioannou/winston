import type { ExecResult } from "@winston/domain/frames";

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
      /** Makes the command idempotent: the same id never runs twice. */
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

export function gatewayClient({
  baseUrl,
  secret,
}: {
  baseUrl: string;
  secret: string;
}): VmClient {
  const headers = { Authorization: `Bearer ${secret}` };
  const url = (path: string) => new URL(path, baseUrl).href;

  const failure = async (response: Response) => {
    const body = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    return new GatewayError(
      body?.error?.code ?? "gateway_error",
      body?.error?.message ??
        `The gateway answered ${String(response.status)}.`,
    );
  };

  const browser = async (
    userId: string,
    action: "hold" | "release",
    owner: string,
  ) => {
    const response = await fetch(
      url(`/internal/vms/${userId}/browser/${action}`),
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ owner }),
      },
    ).catch(() => {
      throw new GatewayError(
        "gateway_unreachable",
        "Couldn't reach the gateway.",
      );
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as {
      window?: { windowId: string; targetId: string; url: string } | null;
    };
  };

  return {
    async holdBrowser(userId, owner) {
      return (await browser(userId, "hold", owner)).window ?? null;
    },
    async releaseBrowser(userId, owner) {
      await browser(userId, "release", owner);
    },
    async exec(userId, request) {
      const response = await fetch(url(`/internal/vms/${userId}/exec`), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      }).catch(() => {
        throw new GatewayError(
          "gateway_unreachable",
          "The gateway isn't reachable.",
        );
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as ExecResult;
    },
    async fetchExec(userId, execId) {
      const response = await fetch(
        url(`/internal/vms/${userId}/execs/${encodeURIComponent(execId)}`),
        { headers },
      ).catch(() => {
        throw new GatewayError(
          "gateway_unreachable",
          "The gateway isn't reachable.",
        );
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw await failure(response);
      return (await response.json()) as ExecResult;
    },
    async writeFile(userId, path, bytes) {
      const response = await fetch(
        url(`/internal/vms/${userId}/files?path=${encodeURIComponent(path)}`),
        { method: "PUT", headers, body: bytes },
      ).catch(() => {
        throw new GatewayError(
          "gateway_unreachable",
          "The gateway isn't reachable.",
        );
      });
      if (!response.ok) throw await failure(response);
    },
    async readFile(userId, path) {
      const response = await fetch(
        url(`/internal/vms/${userId}/files?path=${encodeURIComponent(path)}`),
        { headers },
      ).catch(() => {
        throw new GatewayError(
          "gateway_unreachable",
          "The gateway isn't reachable.",
        );
      });
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
