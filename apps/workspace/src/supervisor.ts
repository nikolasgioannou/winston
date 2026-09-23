import { writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { commandInputSchema } from "@winston/contracts/commands";
import { boundedJson } from "./http-body";
import { cliAuthoritySchema } from "@winston/contracts/cli";

// Only launched under the per-command namespace init, with fixed environment and /app cwd.
if (process.platform !== "linux" || process.getuid?.() !== 0 || process.ppid !== 1)
  throw new Error("Use the protected command launcher.");

try {
  const envelope: unknown = await boundedJson(Bun.stdin.stream(), 16_384);
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("command" in envelope) ||
    !("receiptPath" in envelope) ||
    typeof envelope.receiptPath !== "string"
  )
    throw new Error("Invalid command envelope.");
  const command = commandInputSchema.parse(envelope.command);
  let authorityFd: number | undefined;
  if ("authority" in envelope && envelope.authority !== undefined) {
    const authority = cliAuthoritySchema.parse(envelope.authority);
    const path = `${envelope.receiptPath}.authority`;
    writeFileSync(path, JSON.stringify(authority), { mode: 0o600, flag: "wx" });
    authorityFd = openSync(path, "r");
    unlinkSync(path);
  }
  if (!process.setgroups) throw new Error("Cannot clear supplementary groups.");
  process.setgroups([]);
  const child = Bun.spawn(["/usr/bin/setpriv", "--no-new-privs", "--", ...command.argv], {
    uid: 1000,
    gid: 1000,
    cwd: command.cwd,
    env: command.env,
    stdio:
      authorityFd === undefined
        ? ["ignore", "inherit", "inherit"]
        : ["ignore", "inherit", "inherit", authorityFd],
  });
  if (authorityFd !== undefined) closeSync(authorityFd);
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
  const exitCode = await child.exited;
  writeFileSync(
    envelope.receiptPath,
    JSON.stringify({ exitCode, signal: child.signalCode ?? null }),
    { mode: 0o600, flag: "wx", flush: true },
  );
  process.exit(exitCode);
} catch {
  console.error("Command supervisor could not complete execution.");
  process.exit(125);
}
