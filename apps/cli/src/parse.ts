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
      account: { type: "string" },
      calendar: { type: "string" },
      query: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      from: { type: "string" },
      until: { type: "string" },
      timezone: { type: "string" },
      path: { type: "string" },
      type: { type: "string" },
    },
  });
  const flags = tokens.filter((token) => token.kind === "option").map((token) => token.name);
  if (new Set(flags).size !== flags.length) throw new Error("Options cannot be repeated.");
  const isHelp = values.help === true || !args.length || positionals[0] === "help";
  const words = positionals[0] === "help" ? positionals.slice(1) : positionals;
  if (words.length > 2) throw new Error("Unexpected arguments. Run winston --help.");
  const topic = words.join(".");
  if (isHelp) {
    if (flags.some((flag) => flag !== "help" && flag !== "json"))
      throw new Error("Help does not accept command arguments.");
    return { kind: "help", json: values.json === true, content: help(topic || undefined) };
  }
  const command = commands.find((item) => item.command === topic);
  if (!command) throw new Error("Unknown command. Run winston --help.");
  if (command.command === "files.send") {
    if (flags.some((flag) => !["json", "id", "key"].includes(flag)))
      throw new Error("Unexpected command options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        id: values.id,
        key: values.key,
      }),
    };
  }
  if (command.command === "files.publish") {
    if (flags.some((flag) => !["json", "path", "key", "type"].includes(flag)))
      throw new Error("Unexpected command options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        path: values.path,
        key: values.key,
        mediaType: values.type,
      }),
    };
  }
  if (command.command === "files.inspect") {
    if (flags.some((flag) => flag !== "json" && flag !== "path"))
      throw new Error("Unexpected command options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({ version: 1, command: command.command, path: values.path }),
    };
  }
  if ("flags" in command) {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected command options.");
    const result = cliRequestSchema.safeParse({
      version: 1,
      command: command.command,
      accountId: values.account,
      ...(values.key === undefined ? {} : { key: values.key }),
      ...(values.calendar === undefined ? {} : { calendarId: values.calendar }),
      ...(values.id === undefined ? {} : { id: values.id }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      ...(values.cursor === undefined ? {} : { cursor: JSON.parse(values.cursor) as unknown }),
      ...(command.command === "calendar.events"
        ? {
            window: {
              timeMin: values.from,
              timeMax: values.until,
              timezone: values.timezone,
              query: values.query ?? "",
            },
          }
        : command.command === "gmail.search"
          ? { query: values.query ?? "" }
          : {}),
    });
    if (!result.success) throw new Error("Invalid read arguments. Run winston --help.");
    return { kind: "request", json: values.json === true, request: result.data };
  }
  if (flags.some((flag) => !["json", "id", "service", "key", "detail"].includes(flag)))
    throw new Error("Unexpected command options.");
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
