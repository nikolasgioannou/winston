/**
 * The command table: every resource, its verbs, their flags and real
 * examples (§11). `winston <resource> <verb> [<id>] [--flags]`.
 */
import type { ApiClient } from "./client.ts";
import type { FlagSpec, FlagValues, TextSources } from "./flags.ts";

export interface Context {
  client: ApiClient;
  flags: FlagValues;
  /** Positionals after the verb, e.g. an id. */
  args: string[];
  text: TextSources;
  files: LocalFiles;
}

/** The VM's own disk, which the CLI runs on (choosing where downloads go). */
export interface LocalFiles {
  home: string;
  cwd: string;
  exists: (path: string) => Promise<boolean>;
}

export interface Verb {
  name: string;
  summary: string;
  /** Positional arguments in help, e.g. `<id>`. */
  usage?: string;
  flags: FlagSpec[];
  examples: string[];
  /** Returns what to print. */
  run: (context: Context) => Promise<string>;
}

export interface Resource {
  name: string;
  description: string;
  verbs: Verb[];
}
