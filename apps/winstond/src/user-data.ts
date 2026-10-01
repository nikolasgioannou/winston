/**
 * On EC2, the backend passes the gateway URL and the one-time registration
 * token in the instance's user data, as JSON:
 * `{ "winston": { "gatewayUrl": "…", "registrationToken": "…" } }`
 * (the EC2 VmProvider). winstond reads it through IMDSv2; the agent's shell
 * user can't reach the metadata service (image/scripts/ec2.sh).
 */
export interface BootSettings {
  gatewayUrl?: string | undefined;
  registrationToken?: string | undefined;
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The settings in the user data; empty when there's no metadata service (Docker) or no settings. */
export async function readUserData(
  baseUrl = "http://169.254.169.254",
  fetchImpl: typeof fetch = fetch,
): Promise<BootSettings> {
  try {
    // IMDSv2: a session token first, then the request that carries it.
    const tokenResponse = await fetchImpl(`${baseUrl}/latest/api/token`, {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(1000),
    });
    if (!tokenResponse.ok) return {};
    const response = await fetchImpl(`${baseUrl}/latest/user-data`, {
      headers: { "X-aws-ec2-metadata-token": await tokenResponse.text() },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return {};
    const { winston } = JSON.parse(await response.text()) as {
      winston?: Record<string, unknown>;
    };
    return {
      gatewayUrl: text(winston?.gatewayUrl),
      registrationToken: text(winston?.registrationToken),
    };
  } catch {
    return {};
  }
}
