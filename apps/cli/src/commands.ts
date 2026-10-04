/**
 * The command table: every resource, its verbs, their flags and real
 * examples (§11). `winston <resource> <verb> [<id>] [--flags]`.
 */
import type { ApiClient, LocalClient } from "./client.ts";
import type { FlagSpec, FlagValues, TextSources } from "./flags.ts";

export interface Context {
  client: ApiClient;
  /** winstond's own calls (the browser). */
  local: LocalClient;
  flags: FlagValues;
  /** Positionals after the verb, e.g. an id. */
  args: string[];
  text: TextSources;
  files: LocalFiles;
}

/** The VM's own disk, which the CLI runs on (choosing where downloads go, packing sites). */
export interface LocalFiles {
  home: string;
  cwd: string;
  exists: (path: string) => Promise<boolean>;
  /** Every file under a folder, as paths relative to it; empty if there's no folder. */
  list: (dir: string) => Promise<string[]>;
  read: (path: string) => Promise<Uint8Array>;
  /** Writes a file, creating its folder. */
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  remove: (path: string) => Promise<void>;
}

export interface Verb {
  name: string;
  /** Other names it answers to, for the verb a caller is likely to guess (`list`). */
  aliases?: string[];
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
  /** Id prefixes its `get` verb shows (`evt`); `winston get <id>` routes by them. */
  ids?: string[];
  verbs: Verb[];
}
