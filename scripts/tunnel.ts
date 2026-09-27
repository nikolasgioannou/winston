/**
 * Runs the Cloudflare Tunnel that gives the local api a public HTTPS URL for
 * webhooks. Setup: docs/local-dev.md.
 */
import { loadConfig } from "@winston/shared/config";
import { z } from "zod";

const { TUNNEL_NAME, TUNNEL_ORIGIN_URL } = loadConfig(
  z.object({
    TUNNEL_NAME: z.string().min(1),
    TUNNEL_ORIGIN_URL: z.url(),
  }),
);

const tunnel = Bun.spawn(
  ["cloudflared", "tunnel", "run", "--url", TUNNEL_ORIGIN_URL, TUNNEL_NAME],
  {
    stdio: ["inherit", "inherit", "inherit"],
  },
);
process.exit(await tunnel.exited);
