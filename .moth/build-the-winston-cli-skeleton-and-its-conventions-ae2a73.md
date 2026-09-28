---
id: "ae2a73"
title: Build the winston CLI skeleton and its conventions
status: done
priority: none
labels:
  - cli
  - m2
created_at: 2026-09-27T05:32:51.711Z
updated_at: 2026-09-28T02:37:12.832Z
blocked_by:
  - "8251fd"
---

The CLI is Winston's main toolset. Apart from five native tools, every capability is a `winston` command (docs/design.md §11). Its conventions are an invariant because so much builds on them. Read §11 closely before starting.

Research CLI frameworks for Bun and TypeScript (citty, commander, clipanion, cleye, or a small hand-rolled parser). Judge them on:
- Type-safe flags.
- Nested `winston <resource> <verb>` commands.
- Generated `--help` that supports **real examples per command**.
- "Did you mean `--from`?" suggestions for unknown flags.
- Compiled binary size under `bun build --compile`.

Pick one and justify it briefly in `apps/cli/README.md`.

Build the framework every command will use:
- **Shared flag definitions:** `--account`, `--limit`, `--cursor`, `--since`, `--until`, `--json`, `--dry-run`, and long-text flags accepting a literal, `-` for stdin, or `@path`.
- **Output helpers:** compact one-line-per-record text by default, `--json` when asked, deterministic formatting, times in the user's time zone with offsets, and **always bounded output with a "how to get more" footer**.
- **Error handling:** backend error codes mapped to the fixed exit codes (`0`–`7`), with messages that say what to do next.
- **Transport:** the unix socket client using the Hono RPC types, reading `WINSTON_RUN_TOKEN` from the env.
- **Top-level help:** `winston` with no arguments lists resources with one-line descriptions.
- **First commands:** `winston me get` and `winston me update --timezone <IANA>`.

Tests: flag parsing including stdin and `@file`, output truncation and footers, exit code mapping for each error code, unknown-flag suggestions, and `--json` output.

## Outcome

Built as described in docs/design.md §11 ("As built"). `apps/cli/README.md` records why there's no framework: every candidate would have needed its help, errors and exit codes overridden to meet §11, and the grammar is small.
- **Typing:** response types come from the API through Hono RPC (`InferResponseType<…>`), not hand-written interfaces.
- **Time flags:** `--since` and `--until` are defined but not yet parsed. Human times are the next ticket.
- **Tests:** flags (values, switches, integers, errors, suggestions), long text (literal, stdin, `@file`), bounded lists and footers, deterministic JSON, help at every level, every API error code to its exit code, an unreachable socket, and the `me` commands.
- **Checked in the local VM:** the compiled binary was copied in temporarily; baking it into the image is its own ticket. It printed help, ran `me get` (text and `--json`), suggested a fix for `--jsno` and refused a call without a token.
