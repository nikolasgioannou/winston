import { cliAuthoritySchema, type CliAuthority, type CliResult } from "@winston/contracts/cli";
import { filePublicationSchema, type FilePublication } from "@winston/contracts/artifacts";
import { gatewayBaseURLs, readGatewayResponse } from "./gateway";

export async function publishFile(
  inputAuthority: CliAuthority,
  input: FilePublication,
  bytes: Uint8Array,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<CliResult> {
  const authority = cliAuthoritySchema.parse(inputAuthority);
  const metadata = filePublicationSchema.parse(input);
  const remaining = Date.parse(authority.expiresAt) - Date.now();
  if (!authority.controlToken || remaining <= 0 || remaining > 300_000)
    return {
      version: 1,
      status: "denied",
      message: "File publication authority is unavailable or expired.",
    };
  if (bytes.byteLength !== metadata.size) throw new Error("File size changed.");
  const response = await send(`${gatewayBaseURLs[authority.environment]}/files/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${authority.controlToken}`,
      "X-Winston-Workspace": authority.workspaceId,
      "X-Winston-File": Buffer.from(JSON.stringify(metadata)).toString("base64url"),
    },
    body: Buffer.from(bytes),
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(Math.min(50_000, remaining)),
  });
  return readGatewayResponse(response);
}
