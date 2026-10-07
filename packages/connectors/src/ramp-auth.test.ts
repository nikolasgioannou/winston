import { describe, expect, test } from "bun:test";
import { rampConnectScopes } from "@winston/domain/connections";
import { rampConnectUrl, rampTokenRefresher } from "./ramp-auth.ts";

const client = {
  clientId: "ramp_id_local",
  redirectUri: "http://localhost:3002/auth/ramp/connect/callback",
};

describe("rampConnectUrl", () => {
  test("asks for the spec's scopes and never one that moves money or shows cards", () => {
    const url = new URL(
      rampConnectUrl(client, { state: "s", codeVerifier: "v" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://mcp.ramp.com/oauth/authorize",
    );
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes.sort()).toEqual([...rampConnectScopes].sort());
    for (const never of [
      "cards:read_agentic",
      "cards:write",
      "x402:write",
      "x402_provisioning:write",
      "funds:write",
      "limits:write",
      "bank_accounts:write",
      "banking_drawdown_requests:write",
      "agent_wallet_policy:write",
      "trips:write",
    ])
      expect(scopes).not.toContain(never);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "ramp_id_local",
      redirect_uri: client.redirectUri,
      code_challenge_method: "S256",
      resource: "https://mcp.ramp.com/mcp",
      state: "s",
    });
  });
});

describe("rampTokenRefresher", () => {
  const answering = (status: number, body: unknown) =>
    (() =>
      Promise.resolve(
        Response.json(body, { status }),
      )) as unknown as typeof fetch;

  test("returns the rotated refresh token, and invalid_grant as such", async () => {
    expect(
      await rampTokenRefresher(
        "ramp_id_local",
        answering(200, {
          access_token: "a2",
          refresh_token: "r2",
          expires_in: 3600,
        }),
      )("r1"),
    ).toEqual({ accessToken: "a2", expiresIn: 3600, refreshToken: "r2" });
    expect(
      await rampTokenRefresher(
        "ramp_id_local",
        answering(400, { error: "invalid_grant" }),
      )("r1"),
    ).toBe("invalid_grant");
    expect(
      await rampTokenRefresher(
        "ramp_id_local",
        answering(503, {}),
      )("r1").catch((e: unknown) => e),
    ).toBeInstanceOf(Error);
  });
});
