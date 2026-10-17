/**
 * Registers a Ramp MCP client for one redirect URI and prints its id
 * (docs/runbooks/ramp.md). Ramp's clients are public (no secret), so the id
 * is all an environment keeps, as RAMP_OAUTH_CLIENT_ID. A loopback
 * redirect needs nothing more; a hosted one must first be allowlisted by Ramp.
 *
 *   bun scripts/ramp-client.ts http://127.0.0.1:3002/auth/ramp/connect/callback
 */
// Ramp's dynamic registration, as its MCP server's metadata names it.
const rampRegistrationEndpoint = "https://mcp.ramp.com/register";

const [redirectUri] = process.argv.slice(2);
if (!redirectUri?.startsWith("http")) {
  console.error("Usage: bun scripts/ramp-client.ts <redirect URI>");
  process.exit(1);
}

const response = await fetch(rampRegistrationEndpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Winston",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const body = (await response.json().catch(() => ({}))) as {
  client_id?: string;
};
if (!response.ok || !body.client_id) {
  console.error(
    `Ramp refused the registration (${String(response.status)}): ${JSON.stringify(body)}`,
  );
  process.exit(1);
}
console.log(body.client_id);
