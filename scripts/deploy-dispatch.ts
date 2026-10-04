/**
 * `bun run sites:deploy-dispatch`: deploys the sites' dispatch Worker to
 * Cloudflare (docs/design.md §9a, docs/runbooks/sites.md). CI runs it after
 * `bun run deploy`; it also works from a laptop with the winston-prod
 * profile and the CI token in CLOUDFLARE_API_TOKEN.
 *
 * The Worker verifies site passes with the public half of
 * winston/sites-pass-key, so this reads the secret, derives that half and
 * hands it to wrangler as a var. Without a Cloudflare token it does nothing,
 * so CI passes before the token is set.
 */
import { $ } from "bun";
import {
  sitePassPublicKey,
  sitePassSigningKey,
} from "@winston/site-host/pass-sign";

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.log(
    "No CLOUDFLARE_API_TOKEN: skipping the dispatch Worker (docs/runbooks/sites.md).",
  );
  process.exit(0);
}

const env = {
  ...process.env,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
  WRANGLER_SEND_METRICS: "false",
};

const secret = (
  await $`aws secretsmanager get-secret-value --secret-id winston/sites-pass-key --query SecretString --output text`
    .env(env)
    .text()
).trim();
const publicKey = sitePassPublicKey(sitePassSigningKey(secret));

await $`bun x wrangler deploy --var ${`SITES_PASS_PUBLIC_KEY:${publicKey}`}`
  .cwd(new URL("../apps/sites", import.meta.url).pathname)
  .env(env);
