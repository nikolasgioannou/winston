/**
 * Flags, parsed by hand so errors read the way §11 wants ("Unknown flag
 * `--form`. Did you mean `--from`?") and exit with the usage code.
 */
import { CliError } from "./errors.ts";
import { suggest } from "./suggest.ts";

export interface FlagSpec {
  name: string;
  /** What the flag's value looks like in help, e.g. `<n>`; omitted for switches. */
  value?: string;
  description: string;
  /** Long text: a literal, `-` for stdin, or `@path` for a file. */
  text?: boolean;
  /** A whole number. */
  integer?: boolean;
}

/** The standard flags (§11): the same name and meaning on every resource. */
export const standardFlags = {
  account: {
    name: "account",
    value: "<email>",
    description: "Which connected account (optional if there's only one)",
  },
  limit: {
    name: "limit",
    value: "<n>",
    description: "How many to show (default 20)",
    integer: true,
  },
  cursor: {
    name: "cursor",
    value: "<c>",
    description: "Continue from where the last page ended",
  },
  since: {
    name: "since",
    value: "<time>",
    description: "From this time (ISO-8601 or relative: 2h, 3d, today)",
  },
  until: { name: "until", value: "<time>", description: "Up to this time" },
  json: { name: "json", description: "Machine-readable JSON instead of text" },
  dryRun: {
    name: "dry-run",
    description: "Show what would happen, without doing it",
  },
} satisfies Record<string, FlagSpec>;

/** Flags every command accepts. */
export const globalFlags: FlagSpec[] = [
  standardFlags.json,
  { name: "help", description: "Show help" },
];

export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface Parsed {
  positionals: string[];
  flags: FlagValues;
}

/** Parses `args` against `specs` (plus the global flags). */
export function parseFlags(
  args: readonly string[],
  specs: readonly FlagSpec[],
): Parsed {
  const all = [...specs, ...globalFlags];
  const byName = new Map(all.map((spec) => [spec.name, spec]));
  const positionals: string[] = [];
  const flags: FlagValues = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [rawName = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const spec = byName.get(rawName);
    if (!spec) {
      const guess = suggest(
        rawName,
        all.map((s) => s.name),
      );
      throw CliError.usage(
        `Unknown flag \`--${rawName}\`.${guess ? ` Did you mean \`--${guess}\`?` : ""}`,
        guess ? undefined : "Run with --help to see the flags.",
      );
    }
    if (!spec.value) {
      if (inline !== undefined)
        throw CliError.usage(`\`--${spec.name}\` doesn't take a value.`);
      flags[spec.name] = true;
      continue;
    }
    const value = inline ?? args[(i += 1)];
    if (value === undefined || (inline === undefined && value.startsWith("--")))
      throw CliError.usage(
        `\`--${spec.name}\` needs a value: --${spec.name} ${spec.value}.`,
      );
    if (spec.integer) {
      if (!/^\d+$/.test(value))
        throw CliError.usage(
          `\`--${spec.name}\` must be a whole number, not "${value}".`,
        );
      flags[spec.name] = Number(value);
    } else flags[spec.name] = value;
  }
  return { positionals, flags };
}

/** Where long text can come from: a literal, stdin (`-`), or a file (`@path`). */
export interface TextSources {
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

/** Resolves a long-text flag's value. */
export async function resolveText(value: string, sources: TextSources) {
  if (value === "-") return sources.readStdin();
  if (value.startsWith("@")) {
    const path = value.slice(1);
    try {
      return await sources.readFile(path);
    } catch {
      throw CliError.usage(
        `Couldn't read ${path}.`,
        "Check the path, or pass the text directly or with - for stdin.",
      );
    }
  }
  return value;
}
