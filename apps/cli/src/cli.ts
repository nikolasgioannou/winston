/**
 * Runs one `winston` invocation: finds the command, parses its flags,
 * prints the result or the error, and returns the exit code.
 */
import type { ApiClient, LocalClient } from "./client.ts";
import type { LocalFiles, Resource, Verb } from "./commands.ts";
import { CliError } from "./errors.ts";
import {
  globalFlags,
  parseFlags,
  type FlagSpec,
  type TextSources,
} from "./flags.ts";
import { accounts } from "./resources/accounts.ts";
import { browser } from "./resources/browser.ts";
import { calendar } from "./resources/calendar.ts";
import { events } from "./resources/events.ts";
import { history } from "./resources/history.ts";
import { mail } from "./resources/mail.ts";
import { me } from "./resources/me.ts";
import { site } from "./resources/site.ts";
import { task } from "./resources/task.ts";
import { trigger } from "./resources/trigger.ts";
import { suggest } from "./suggest.ts";
import { version } from "./version.ts";

export const resources: Resource[] = [
  me,
  mail,
  calendar,
  accounts,
  task,
  trigger,
  events,
  history,
  browser,
  site,
];

/** Every prefix `winston get` knows, as `msg_, thr_, …`. */
const knownIds = () =>
  resources.flatMap((r) => (r.ids ?? []).map((p) => `${p}_`)).join(", ");

/** A TypeID: a lowercase prefix, then 26 base32 characters (§11 identifiers). */
const typeIdPattern = /^([a-z]+(?:_[a-z]+)*)_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** The resource whose `get` shows `id`, found by its prefix. */
function ownerOf(id: string): [Resource, Verb] {
  const prefix = typeIdPattern.exec(id)?.[1];
  if (!prefix)
    throw CliError.usage(
      `"${id}" isn't an id.`,
      `Ids look like evt_01k5…: a prefix (${knownIds()}) and 26 characters.`,
    );
  const resource = resources.find((r) => r.ids?.includes(prefix));
  const verb = resource?.verbs.find((v) => v.name === "get");
  if (!resource || !verb)
    throw CliError.usage(
      `winston get doesn't know ${prefix}_ ids.`,
      `It knows ${knownIds()}.`,
    );
  return [resource, verb];
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  text: TextSources;
  files: LocalFiles;
  client: () => ApiClient;
  local: () => LocalClient;
}

const pad = (text: string, width: number) => text.padEnd(width);

function flagLines(flags: readonly FlagSpec[]) {
  const labels = flags.map(
    (flag) => `--${flag.name}${flag.value ? ` ${flag.value}` : ""}`,
  );
  const width = Math.max(...labels.map((label) => label.length)) + 2;
  return flags.map(
    (flag, i) => `  ${pad(labels[i] ?? "", width)}${flag.description}`,
  );
}

export function topHelp() {
  const width = Math.max(...resources.map((r) => r.name.length)) + 2;
  return [
    "winston: your tools, as a command line.",
    "",
    "Usage: winston <resource> <verb> [<id>] [--flags]",
    "",
    "Resources:",
    ...resources.map((r) => `  ${pad(r.name, width)}${r.description}`),
    "",
    `Any object by its id: winston get <id> (${knownIds()})`,
    "",
    "Run `winston <resource> --help` for its verbs, flags and examples.",
  ].join("\n");
}

export function resourceHelp(resource: Resource) {
  const width = Math.max(...resource.verbs.map((v) => v.name.length)) + 2;
  return [
    `winston ${resource.name}: ${resource.description}`,
    "",
    "Verbs:",
    ...resource.verbs.map((v) => `  ${pad(v.name, width)}${v.summary}`),
    "",
    "Examples:",
    ...resource.verbs.flatMap((v) => v.examples.map((e) => `  ${e}`)),
    "",
    `Run \`winston ${resource.name} <verb> --help\` for a verb's flags.`,
  ].join("\n");
}

export function verbHelp(resource: Resource, verb: Verb) {
  return [
    `winston ${resource.name} ${verb.name}${verb.usage ? ` ${verb.usage}` : ""}: ${verb.summary}`,
    "",
    "Flags:",
    ...flagLines([...verb.flags, ...globalFlags]),
    "",
    "Examples:",
    ...verb.examples.map((e) => `  ${e}`),
  ].join("\n");
}

/** Parses a verb's flags and runs it (or prints its help). */
async function runVerb(
  io: Io,
  resource: Resource,
  verb: Verb,
  args: readonly string[],
) {
  const { positionals, flags } = parseFlags(args, verb.flags);
  if (flags.help === true) {
    io.out(verbHelp(resource, verb));
    return 0;
  }
  io.out(
    await verb.run({
      client: io.client(),
      local: io.local(),
      flags,
      args: positionals,
      text: io.text,
      files: io.files,
    }),
  );
  return 0;
}

/** Runs `argv` (without the program name) and returns the exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const [resourceName, verbName, ...rest] = argv;
  try {
    if (
      resourceName === undefined ||
      resourceName === "--help" ||
      resourceName === "help"
    ) {
      io.out(topHelp());
      return 0;
    }
    if (resourceName === "--version") {
      io.out(version);
      return 0;
    }
    if (resourceName === "get") {
      if (verbName === undefined || verbName === "--help") {
        io.out(
          `winston get <id>: any object by its id, shown as its resource's get shows it.\nIt knows ${knownIds()}.`,
        );
        return 0;
      }
      const [resource, verb] = ownerOf(verbName);
      return await runVerb(io, resource, verb, [verbName, ...rest]);
    }
    const resource = resources.find((r) => r.name === resourceName);
    if (!resource) {
      const guess = suggest(
        resourceName,
        resources.map((r) => r.name),
      );
      throw CliError.usage(
        `Unknown resource \`${resourceName}\`.${guess ? ` Did you mean \`${guess}\`?` : ""}`,
        "Run `winston` to list the resources.",
      );
    }
    if (verbName === undefined || verbName === "--help") {
      io.out(resourceHelp(resource));
      return 0;
    }
    const verb = resource.verbs.find(
      (v) => v.name === verbName || v.aliases?.includes(verbName),
    );
    if (!verb) {
      const guess = suggest(
        verbName,
        resource.verbs.map((v) => v.name),
      );
      throw CliError.usage(
        `Unknown verb \`${verbName}\` for ${resource.name}.${guess ? ` Did you mean \`${guess}\`?` : ""}`,
        `Run \`winston ${resource.name} --help\` to see its verbs.`,
      );
    }
    return await runVerb(io, resource, verb, rest);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.err(error.hint ? `${error.message}\n${error.hint}` : error.message);
    return error.exitCode;
  }
}
