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
      cmd: string;
      cwd?: string;
      env: Record<string, string>;
      timeoutMs: number;
    },
  ): Promise<ExecResult>;
  writeFile(userId: string, path: string, bytes: Uint8Array): Promise<void>;
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

  return {
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
  };
}
