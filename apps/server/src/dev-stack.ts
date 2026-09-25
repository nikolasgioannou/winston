import { fileURLToPath } from "node:url";
import { createDatabase } from "@winston/adapters/database";
import { validateRuntimeEnvironment } from "./environment";
import { readAuthConfig } from "./auth-config";
import { readConnectionConfig } from "./connection-config";
import { readStorageConfig } from "./storage-config";
import { runDevelopmentCommand } from "./development/runner";
import { checkDevelopmentPort } from "./development/ports";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "bun run dev:stack [--telegram] [--check]\n--telegram starts the development bot poller. --check validates configuration and database without launching services.",
    );
    return;
  }
  if (
    args.some((arg) => !["--telegram", "--check"].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error("Use bun run dev:stack [--telegram] [--check].");
  if (process.env.NODE_ENV === "production")
    throw new Error("dev:stack cannot run in production mode.");
  validateRuntimeEnvironment(process.env);
  const config = readAuthConfig(process.env);
  readConnectionConfig(process.env, config.auth.baseURL);
  readStorageConfig(process.env);
  if (
    config.auth.baseURL !== "http://127.0.0.1:3001" ||
    config.auth.webOrigin !== "http://127.0.0.1:5173" ||
    (process.env.PORT && process.env.PORT !== "3001") ||
    (process.env.HOST && process.env.HOST !== "127.0.0.1")
  )
    throw new Error(
      "The local stack uses API http://127.0.0.1:3001 and web http://127.0.0.1:5173. Match HOST, PORT, BETTER_AUTH_URL, WEB_ORIGIN and your local OAuth callbacks.",
    );
  if (args.includes("--telegram") && !process.env.TELEGRAM_BOT_TOKEN)
    throw new Error("Set a dedicated development TELEGRAM_BOT_TOKEN before using --telegram.");
  if (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_WEBHOOK_SECRET) {
    if (
      !process.env.TELEGRAM_BOT_TOKEN ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.TELEGRAM_WEBHOOK_SECRET ?? "")
    )
      throw new Error(
        "Telegram configuration requires a development bot token and a valid TELEGRAM_WEBHOOK_SECRET.",
      );
  }
  const database = createDatabase({
    connectionString: config.connectionString,
    onConnectionError: () => {},
  });
  try {
    await database.assertCompatible();
  } catch {
    throw new Error(
      "Local database is unavailable or needs migrations. Start the local database and run bun run db:migrate.",
    );
  } finally {
    await database.close();
  }
  if (args.includes("--check")) {
    console.log("Local configuration and database schema are valid. No services were started.");
    return;
  }
  await checkDevelopmentPort(3001);
  await checkDevelopmentPort(5173);
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.log("Starting Winston at http://127.0.0.1:5173. Press Ctrl-C to stop the stack.");
    process.exitCode = await runDevelopmentCommand(
      [
        process.execPath,
        "--no-env-file",
        "run",
        "--parallel",
        "dev:server",
        "dev",
        ...(args.includes("--telegram") ? ["dev:telegram"] : []),
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: { ...process.env, NODE_ENV: "development" },
        signal: controller.signal,
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local stack startup failed.");
  process.exitCode = 1;
}
