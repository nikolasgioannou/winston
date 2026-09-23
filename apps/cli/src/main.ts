import { runCli } from "./run";
import { readAuthority } from "./authority";
import { callGateway } from "./gateway";

const result = await runCli(process.argv.slice(2), async (request) => {
  let authority;
  try {
    authority = readAuthority();
  } catch {
    return {
      version: 1,
      status: "denied",
      message: "Run this command with authority supplied by the task runtime.",
    };
  }
  return callGateway(authority, request);
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
