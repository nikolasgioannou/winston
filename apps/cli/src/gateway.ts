import {
  cliAuthoritySchema,
  cliRequestSchema,
  cliResultSchema,
  type CliAuthority,
  type CliRequest,
  type CliResult,
} from "@winston/contracts/cli";

// Credential destinations are application-owned, never supplied through arguments or the authority channel.
const endpoints = {
  production: "https://winston-628.fly.dev/api/tasks/cli",
  local: "http://127.0.0.1:3001/api/tasks/cli",
} as const;

export async function callGateway(
  inputAuthority: CliAuthority,
  input: CliRequest,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CliResult> {
  const authority = cliAuthoritySchema.parse(inputAuthority);
  const request = cliRequestSchema.parse(input);
  const remaining = Date.parse(authority.expiresAt) - Date.now();
  if (remaining <= 0 || remaining > 300_000)
    return { version: 1, status: "denied", message: "Task authority is expired or invalid." };
  const response = await send(endpoints[authority.environment], {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authority.token}`,
      "X-Winston-Workspace": authority.workspaceId,
    },
    body: JSON.stringify(request),
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(Math.min(15_000, remaining)),
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { version: 1, status: "denied", message: "Task authority is unavailable or expired." };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Gateway outcome unavailable.");
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 1_048_576) throw new Error("Gateway response exceeds limit.");
      chunks.push(item.value);
    }
    return cliResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel();
  }
}
