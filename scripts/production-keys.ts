/**
 * `bun run prod:keys`: sets production's external keys and points Telegram at
 * production (docs/runbooks/secrets.md). Run it yourself: it asks for each
 * value with typing hidden, so keys never reach a chat, a file in the repo or
 * your shell history. Leave an answer blank to keep the current value.
 *
 *   1. @RunWinstonBot's token (from @BotFather), and the site's key for
 *      checking Telegram sign-ins, derived from it (once, if it's missing)
 *   2. The production OpenRouter key
 *   3. The "Winston production" Google OAuth client's id and secret
 *   4. The backend's Cloudflare token for sites ("winston-backend")
 *
 * Then it restarts the services that read what changed, and, once
 * api.runwinston.com resolves, registers the bot's webhook with the generated
 * webhook secret and shows Telegram's view of it. `--webhook` skips straight
 * to the webhook. Needs `aws sso login --profile winston-prod` first.
 */
import { $ } from "bun";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceSecrets, type Service } from "../infra/src/secret-names.ts";

const env = {
  ...process.env,
  AWS_REGION: "us-east-1",
  AWS_PROFILE: process.env.AWS_PROFILE ?? "winston-prod",
};
const domain = "runwinston.com";

/** The services that read a secret, from the same table the stack uses. */
const readersOf = (secret: string) =>
  (Object.keys(serviceSecrets) as Service[]).filter((service) =>
    Object.values(serviceSecrets[service]).some(
      (ref: string | readonly [string, string]) =>
        (typeof ref === "string" ? ref : ref[0]) === secret,
    ),
  );

/** Asks a question with the terminal's echo off. */
async function askHidden(question: string) {
  process.stdout.write(question);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

/** Stores a secret's value through a private temporary file, never argv. */
async function putSecret(name: string, value: string) {
  const dir = await mkdtemp(join(tmpdir(), "winston-secret-"));
  const file = join(dir, "value");
  try {
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
    await $`aws secretsmanager put-secret-value --secret-id ${name} --secret-string ${`file://${file}`}`
      .env(env)
      .quiet();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readSecret = async (name: string) =>
  (
    await $`aws secretsmanager get-secret-value --secret-id ${name} --query SecretString --output text`
      .env(env)
      .quiet()
      .text()
  ).trim();

const identity =
  await $`aws sts get-caller-identity --query Account --output text`
    .env(env)
    .quiet()
    .nothrow();
if (identity.exitCode !== 0 || identity.text().trim() !== "766577085959") {
  console.error("Log in first: aws sso login --profile winston-prod");
  process.exit(1);
}

const changed = new Set<Service>();
if (!Bun.argv.includes("--webhook")) {
  console.log(
    "Production keys. Typing is hidden; blank keeps the current value.\n",
  );

  const botToken = await askHidden("@RunWinstonBot token (from @BotFather): ");
  if (botToken) {
    if (!/^\d+:[\w-]+$/.test(botToken)) {
      console.error("That isn't a bot token (digits, a colon, then letters).");
      process.exit(1);
    }
    await putSecret("winston/telegram-bot-token", botToken);
    for (const service of readersOf("telegram-bot-token")) changed.add(service);
  }
  // The site checks Telegram sign-ins with SHA-256 of the token, never the
  // token itself: derived from the token just set, or from the stored one
  // when the key isn't set yet.
  const loginKey = await readSecret("winston/telegram-login-key");
  if (botToken || !/^[0-9a-f]{64}$/.test(loginKey)) {
    const token = botToken || (await readSecret("winston/telegram-bot-token"));
    if (/^\d+:[\w-]+$/.test(token)) {
      await putSecret(
        "winston/telegram-login-key",
        new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      );
      for (const service of readersOf("telegram-login-key"))
        changed.add(service);
    }
  }

  const openRouter = await askHidden("Production OpenRouter API key: ");
  if (openRouter) {
    await putSecret("winston/openrouter-api-key", openRouter);
    for (const service of readersOf("openrouter-api-key")) changed.add(service);
  }

  const clientId = await askHidden(
    'Google OAuth client id ("Winston production"): ',
  );
  const clientSecret = clientId
    ? await askHidden("Google OAuth client secret: ")
    : "";
  if (clientId && clientSecret) {
    await putSecret(
      "winston/google-oauth",
      JSON.stringify({ clientId, clientSecret }),
    );
    for (const service of readersOf("google-oauth")) changed.add(service);
  }

  const cloudflare = await askHidden(
    'Cloudflare token "winston-backend" (docs/runbooks/sites.md): ',
  );
  if (cloudflare) {
    await putSecret("winston/cloudflare-api-token", cloudflare);
    for (const service of readersOf("cloudflare-api-token"))
      changed.add(service);
  }

  if (changed.size > 0) {
    const cluster = (
      await $`aws cloudformation describe-stacks --stack-name winston-services --query ${"Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue"} --output text`
        .env(env)
        .text()
    ).trim();
    const services = (
      await $`aws ecs list-services --cluster ${cluster} --query serviceArns --output text`
        .env(env)
        .text()
    )
      .trim()
      .split(/\s+/);
    for (const name of changed) {
      const arn = services.find((service) =>
        service.includes(`-${name}Service`),
      );
      if (!arn) continue;
      await $`aws ecs update-service --cluster ${cluster} --service ${arn} --force-new-deployment`
        .env(env)
        .quiet();
      console.log(`Restarting ${name} so it reads the new values.`);
    }
  }
}

// Telegram must reach api.runwinston.com before the webhook can point there.
const resolves = (
  await $`dig +short ${`api.${domain}`}`.nothrow().text()
).trim();
if (!resolves) {
  console.log(
    `\napi.${domain} doesn't resolve yet: add its CNAME (docs/runbooks/dns.md), then run \`bun run prod:keys --webhook\`.`,
  );
  process.exit(0);
}
console.log("\nPointing @RunWinstonBot at production…");
await $`bun src/telegram/set-webhook.ts`.cwd("apps/api").env({
  ...process.env,
  TELEGRAM_BOT_TOKEN: await readSecret("winston/telegram-bot-token"),
  TELEGRAM_WEBHOOK_SECRET: await readSecret("winston/telegram-webhook-secret"),
  API_PUBLIC_URL: `https://api.${domain}`,
});
