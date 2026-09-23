import {
  cliExitCodes,
  cliResultSchema,
  type CliRequest,
  type CliResult,
} from "@winston/contracts/cli";
import { parseCommand } from "./parse";

type Output = { exitCode: number; stdout: string; stderr: string };

function output(result: CliResult, json: boolean): Output {
  const exitCode = cliExitCodes[result.status];
  if (json) return { exitCode, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
  if (result.status === "ok")
    return { exitCode, stdout: `${JSON.stringify(result.data, null, 2)}\n`, stderr: "" };
  // Never interpret control sequences originating in provider or gateway descriptions.
  // eslint-disable-next-line no-control-regex -- Deliberately strip terminal control characters.
  const message = result.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return {
    exitCode,
    stdout: "",
    stderr: `${result.status}: ${message}${result.referenceId ? ` (${result.referenceId})` : ""}\n`,
  };
}

export async function runCli(
  args: string[],
  execute: (request: CliRequest) => Promise<CliResult>,
): Promise<Output> {
  let parsed;
  try {
    parsed = parseCommand(args);
  } catch {
    return output(
      {
        version: 1,
        status: "invalid_input",
        message: "Invalid command or arguments. Run winston --help.",
      },
      args.includes("--json"),
    );
  }
  if (parsed.kind === "help") {
    if (parsed.json) return output({ version: 1, status: "ok", data: parsed.content }, true);
    return {
      exitCode: 0,
      stdout: `${parsed.content.commands.map((item) => `${item.usage}\n  ${item.description}`).join("\n\n")}\n`,
      stderr: "",
    };
  }
  try {
    return output(cliResultSchema.parse(await execute(parsed.request)), parsed.json);
  } catch {
    return output(
      {
        version: 1,
        status: "unknown",
        message: "The outcome could not be verified. Inspect the operation before retrying.",
      },
      parsed.json,
    );
  }
}
