import { parseArgs } from "node:util";
import { cliRequestSchema, type CliRequest } from "@winston/contracts/cli";
import { commands, help } from "./commands";
import { parseCalendarMutation } from "./calendar-mutation";
import { parseGmailMutation } from "./gmail-mutation";

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
      part: { type: "string" },
      service: { type: "string" },
      key: { type: "string" },
      detail: { type: "string" },
      account: { type: "string" },
      calendar: { type: "string" },
      event: { type: "string" },
      message: { type: "string" },
      "message-id": { type: "string" },
      "add-labels": { type: "string" },
      "remove-labels": { type: "string" },
      changes: { type: "string" },
      etag: { type: "string" },
      notify: { type: "string" },
      query: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      from: { type: "string" },
      until: { type: "string" },
      timezone: { type: "string" },
      path: { type: "string" },
      type: { type: "string" },
      objective: { type: "string" },
      at: { type: "string" },
      rule: { type: "string" },
      revision: { type: "string" },
      after: { type: "string" },
      purpose: { type: "string" },
      scope: { type: "string" },
      response: { type: "string" },
      alias: { type: "string" },
      responsibility: { type: "string" },
      "agreement-revision": { type: "string" },
      argv: { type: "string" },
      cwd: { type: "string" },
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
    return {
      kind: "help",
      json: values.json === true,
      content: help(topic || undefined, values.json === true),
    };
  }
  const command = commands.find((item) => item.command === topic);
  if (!command) throw new Error("Unknown command. Run winston --help.");
  if (command.command === "gmail.trash" || command.command === "gmail.restore") {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected trash/restore options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        key: values.key,
        accountId: values.account,
        messageId: values.id,
      }),
    };
  }
  if (command.command === "gmail.modify") {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected Gmail label options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        key: values.key,
        accountId: values.account,
        messageId: values.id,
        addLabelIds: JSON.parse(values["add-labels"] ?? "[]") as unknown,
        removeLabelIds: JSON.parse(values["remove-labels"] ?? "[]") as unknown,
      }),
    };
  }
  if (
    command.command === "gmail.draft-create" ||
    command.command === "gmail.draft-update" ||
    command.command === "gmail.send" ||
    command.command === "gmail.draft-send"
  ) {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected Gmail mutation options.");
    return {
      kind: "request",
      json: values.json === true,
      request: parseGmailMutation(command.command, values),
    };
  }
  if (
    command.command === "calendar.create" ||
    command.command === "calendar.update" ||
    command.command === "calendar.delete" ||
    command.command === "calendar.rsvp"
  ) {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected Calendar mutation options.");
    return {
      kind: "request",
      json: values.json === true,
      request: parseCalendarMutation(command.command, values),
    };
  }
  if (command.command === "devices.command") {
    if (flags.some((flag) => !["json", "id", "key", "argv", "cwd"].includes(flag)))
      throw new Error("Unexpected device command options.");
    const argv: unknown = JSON.parse(values.argv ?? "null");
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      !argv.every((item: unknown) => typeof item === "string")
    )
      throw new Error("Provide a literal JSON argv array.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        id: values.id,
        key: values.key,
        operation: {
          kind: "command",
          executable: argv[0],
          arguments: argv.slice(1),
          directory: values.cwd,
        },
      }),
    };
  }
  if (command.command === "devices.result") {
    if (
      flags.some((flag) => !["json", "id", "after"].includes(flag)) ||
      (values.after !== undefined && !/^(?:-1|\d+)$/.test(values.after))
    )
      throw new Error("Invalid device result options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        id: values.id,
        after: values.after === undefined ? -1 : Number(values.after),
      }),
    };
  }
  if (command.command.startsWith("responsibilities.") && "flags" in command) {
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected responsibility options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        ...(values.id === undefined ? {} : { id: values.id }),
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(values.key === undefined ? {} : { key: values.key }),
        ...(values.purpose === undefined ? {} : { purpose: values.purpose }),
        ...(values.scope === undefined ? {} : { scope: JSON.parse(values.scope) as unknown }),
      }),
    };
  }
  if (command.command.startsWith("schedules.") && "flags" in command) {
    if (values.revision !== undefined && !/^\d+$/.test(values.revision))
      throw new Error("Invalid schedule revision.");
    const agreementRevision = values["agreement-revision"];
    if (
      (values.responsibility === undefined) !== (agreementRevision === undefined) ||
      (agreementRevision !== undefined && !/^\d+$/.test(agreementRevision))
    )
      throw new Error("Provide a responsibility and its agreement revision together.");
    const allowed: readonly string[] = command.flags;
    if (flags.some((flag) => flag !== "json" && !allowed.includes(flag)))
      throw new Error("Unexpected schedule options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        ...(values.id === undefined ? {} : { id: values.id }),
        ...(values.key === undefined ? {} : { key: values.key }),
        ...(values.objective === undefined ? {} : { objective: values.objective }),
        ...(values.at === undefined ? {} : { startAt: values.at }),
        ...(values.rule === undefined ? {} : { rule: values.rule }),
        ...(values.timezone === undefined ? {} : { timezone: values.timezone }),
        ...(values.revision === undefined ? {} : { revision: Number(values.revision) }),
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(values.responsibility === undefined
          ? {}
          : {
              responsibility: {
                id: values.responsibility,
                agreementRevision: Number(agreementRevision),
              },
            }),
      }),
    };
  }
  if (
    command.command === "files.send" ||
    command.command === "calendar.reconcile" ||
    command.command === "gmail.reconcile"
  ) {
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
  if (command.command === "files.stage") {
    if (flags.some((flag) => !["json", "id", "revision", "key"].includes(flag)))
      throw new Error("Unexpected command options.");
    if (values.revision === undefined || !/^\d+$/.test(values.revision))
      throw new Error("An exact artifact revision is required.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        id: values.id,
        revision: Number(values.revision),
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
      ...(values.part === undefined ? {} : { partId: values.part }),
      ...(values.key === undefined ? {} : { key: values.key }),
      ...(values.calendar === undefined ? {} : { calendarId: values.calendar }),
      ...(values.id === undefined ? {} : { id: values.id }),
      ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
      ...(values.cursor === undefined ? {} : { cursor: JSON.parse(values.cursor) as unknown }),
      ...(command.command === "calendar.events" || command.command === "calendar.availability"
        ? {
            window: {
              timeMin: values.from,
              timeMax: values.until,
              timezone: values.timezone,
              ...(command.command === "calendar.events" ? { query: values.query ?? "" } : {}),
            },
          }
        : command.command === "gmail.search" || command.command === "gmail.drafts"
          ? { query: values.query ?? "" }
          : {}),
    });
    if (!result.success) throw new Error("Invalid read arguments. Run winston --help.");
    return { kind: "request", json: values.json === true, request: result.data };
  }
  if (command.command === "accounts.resolve") {
    if (flags.some((flag) => !["json", "service", "alias"].includes(flag)))
      throw new Error("Unexpected account resolution options.");
    return {
      kind: "request",
      json: values.json === true,
      request: cliRequestSchema.parse({
        version: 1,
        command: command.command,
        service: values.service,
        alias: values.alias,
      }),
    };
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
