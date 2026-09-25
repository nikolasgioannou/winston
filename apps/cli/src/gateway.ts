import {
  cliAuthoritySchema,
  cliRequestSchema,
  cliResultSchema,
  cliReadRequestSchema,
  cliCalendarMutationRequestSchema,
  cliGmailMutationRequestSchema,
  isScheduleMutation,
  type CliAuthority,
  type CliRequest,
  type CliResult,
} from "@winston/contracts/cli";

// Credential destinations are application-owned, never supplied through arguments or the authority channel.
export const gatewayBaseURLs = {
  production: "https://winston-628.fly.dev/api/tasks",
  local: "http://127.0.0.1:3001/api/tasks",
} as const;

export async function callGateway(
  inputAuthority: CliAuthority,
  input: CliRequest,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CliResult> {
  const authority = cliAuthoritySchema.parse(inputAuthority);
  const request = cliRequestSchema.parse(input);
  const control =
    request.command === "operations.cancel" ||
    isScheduleMutation(request.command) ||
    ("key" in request && request.key !== undefined);
  const token = control ? authority.controlToken : authority.token;
  if (!token)
    return { version: 1, status: "denied", message: "Task control authority is unavailable." };
  const remaining = Date.parse(authority.expiresAt) - Date.now();
  if (remaining <= 0 || remaining > 300_000)
    return { version: 1, status: "denied", message: "Task authority is expired or invalid." };
  const response = await send(
    `${gatewayBaseURLs[authority.environment]}/cli${control ? "/control" : ""}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Winston-Workspace": authority.workspaceId,
      },
      body: JSON.stringify(request),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(
        Math.min(
          cliCalendarMutationRequestSchema.safeParse(request).success ||
            cliGmailMutationRequestSchema.safeParse(request).success ||
            request.command === "calendar.reconcile" ||
            request.command === "gmail.reconcile"
            ? 55_000
            : cliReadRequestSchema.safeParse(request).success
              ? 45_000
              : 15_000,
          remaining,
        ),
      ),
    },
  );
  return readGatewayResponse(response);
}

export async function readGatewayResponse(response: Response): Promise<CliResult> {
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
