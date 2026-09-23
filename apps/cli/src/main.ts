import { runCli } from "./run";
import { readAuthority } from "./authority";
import { callGateway } from "./gateway";
import { snapshotPublishFile } from "./files";

const result = await runCli(process.argv.slice(2), async (request) => {
  if (request.command === "files.inspect") {
    try {
      return { version: 1, status: "ok", data: (await snapshotPublishFile(request.path)).metadata };
    } catch {
      return {
        version: 1,
        status: "unavailable",
        message:
          "Use a completed regular file of at most 50 MiB in /data/home/artifacts. Links and changing files are not accepted.",
      };
    }
  }
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
