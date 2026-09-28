# winston CLI

Winston's tools as a command line: `winston <resource> <verb> [<id>] [--flags]`. The conventions are in docs/design.md §11 (a Part 3 invariant). Every call goes through winstond's unix socket (§15).

## Why no CLI framework

commander, citty, clipanion and cleye were considered. Each brings its own help layout, error wording and exit behaviour, and §11 needs all three to be ours:

- Help with real examples at every level.
- "Unknown flag `--form`. Did you mean `--from`?"
- The fixed exit codes 0–7, and every error saying what to do next.

The grammar is deliberately tiny and uniform, so a declarative command table (`src/commands.ts`, `src/resources/`) and a ~100-line flag parser (`src/flags.ts`) keep full control with no dependency. The compiled binary (~80 MB) is almost entirely the Bun runtime.

## Adding a command

Add a `Resource` in `src/resources/` and list it in `src/cli.ts`.

- **Flags:** reuse `standardFlags` (`--account`, `--limit`, `--cursor`, `--since`, `--until`, `--dry-run`); `--json` and `--help` are global. Mark long text with `text: true` and read it with `resolveText`, which takes a literal, `-` or `@path`.
- **Output:** print with `record` (one line per object, id first) and `list` (bounded, with a footer), or `json`.
- **Calls:** use `call(client.v1…)`. The client is typed from the VM-facing API (`@winston/vm-api`), and backend errors become the right exit codes.
