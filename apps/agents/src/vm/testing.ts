import type { ExecResult } from "@winston/domain/frames";
import type { VmClient } from "./gateway-client.ts";

export const testRunTokenSecret = "run-token-secret-for-tests-0123456789";

/** A VM client for tests: records commands and answers each with `answer` (by default, success with no output). */
export function fakeVmClient(
  answer: (cmd: string) => Partial<ExecResult> = () => ({}),
) {
  const commands: string[] = [];
  const client: VmClient = {
    exec: (_userId, request) => {
      commands.push(request.cmd);
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
        ...answer(request.cmd),
      });
    },
    writeFile: () => Promise.resolve(),
  };
  return { client, commands };
}
