import { parseArgs } from "node:util";
import { cliRequestSchema, type CliRequest } from "@winston/contracts/cli";
import { commands, help } from "./commands";

export type ParsedCommand =
  | { kind: "help"; json: boolean; content: ReturnType<typeof help> }
  | { kind: "request"; json: boolean; request: CliRequest };

export function parseCommand(args: string[]): ParsedCommand {
  const { values, positionals, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      id: { type: "string" },
      service: { type: "string" },
      key: { type: "string" },
      detail: { type: "string" },
    },
  });
  const flags = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(flags).size !== flags.length) throw new Error("Options cannot be repeated.");
  const isHelp = values.help === true || !args.length || positionals[0] === "help";
  const words = positionals[0] === "help" ? positionals.slice(1) : positionals;
  if (words.length > 2) throw new Error("Unexpected arguments. Run winston --help.");
  const topic = words.join(".");
  if (isHelp) {
    if ([values.id, values.service, values.key, values.detail].some((value) => value !== undefined))
      throw new Error("Help does not accept command arguments.");
    return { kind: "help", json: values.json === true, content: help(topic || undefined) };
  }
  const command = commands.find((item) => item.command === topic);
  if (!command) throw new Error("Unknown command. Run winston --help.");
  const connection = command.command === "accounts.connect";
  if (
    !connection &&
    [values.service, values.key, values.detail].some((value) => value !== undefined)
  )
    throw new Error("Unexpected command options.");
  if (!connection && !command.id && values.id !== undefined)
    throw new Error("This command does not accept --id.");
  const result = cliRequestSchema.safeParse({
    version: 1,
    command: command.command,
    ...(values.id === undefined ? {} : { id: values.id }),
    ...(connection ? { service: values.service, key: values.key, detail: values.detail } : {}),
  });
  if (!result.success) throw new Error("Provide --id with a valid resource UUID.");
  return { kind: "request", json: values.json === true, request: result.data };
}
