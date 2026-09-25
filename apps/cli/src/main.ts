import { runCli } from "./run";
import { readAuthority } from "./authority";
import { callGateway } from "./gateway";
import { snapshotPublishFile } from "./files";
import { publishFile } from "./file-gateway";
import { callDeviceCommand } from "./device-command";

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
  if (request.command === "files.publish") {
    const file = await snapshotPublishFile(request.path);
    return publishFile(
      authority,
      {
        version: 1,
        key: request.key,
        name: file.metadata.name,
        mediaType: request.mediaType,
        size: file.metadata.size,
        sha256: file.metadata.sha256,
      },
      file.bytes,
    );
  }
  return request.command === "devices.command" || request.command === "devices.read"
    ? callDeviceCommand(authority, request)
    : callGateway(authority, request);
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
