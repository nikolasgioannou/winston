/**
 * Runs one `winston` invocation: finds the command, parses its flags,
 * prints the result or the error, and returns the exit code.
 */
import type { ApiClient } from "./client.ts";
import type { LocalFiles, Resource, Verb } from "./commands.ts";
import { CliError } from "./errors.ts";
import {
  globalFlags,
  parseFlags,
  type FlagSpec,
  type TextSources,
} from "./flags.ts";
import { mail } from "./resources/mail.ts";
import { me } from "./resources/me.ts";
import { suggest } from "./suggest.ts";
import { version } from "./version.ts";

export const resources: Resource[] = [me, mail];

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  text: TextSources;
  files: LocalFiles;
  client: () => ApiClient;
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
    const verb = resource.verbs.find((v) => v.name === verbName);
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
    const { positionals, flags } = parseFlags(rest, verb.flags);
    if (flags.help === true) {
      io.out(verbHelp(resource, verb));
      return 0;
    }
    io.out(
      await verb.run({
        client: io.client(),
        flags,
        args: positionals,
        text: io.text,
        files: io.files,
      }),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    io.err(error.hint ? `${error.message}\n${error.hint}` : error.message);
    return error.exitCode;
  }
}
