---
id: "0343d4"
title: The run token is visible in the VM's process list
status: done
priority: medium
labels:
  - security
  - vm
parent: "07ba81"
created_at: 2026-10-24T16:49:56.973Z
updated_at: 2026-10-24T18:54:04.200Z
---

`apps/winstond/src/exec.ts` runs each command as `sudo -n -u winston -- env -i … WINSTON_RUN_TOKEN=<token> … bash -lc <command>`. Both the token and the command text are on the command line, so any process listing shows them.

**From the trace audit (07ba81):**

- **Oct 5 and Oct 13:** `pgrep -af` / `ps` output printed the full wrapper line, including `WINSTON_RUN_TOKEN=eyJ…`. It went into the model context and the stored traces.
- **The same incidents:** `pkill -f "…mock.py…"` matched the run's own `bash -lc <command>` wrapper and killed it (exit 143) before the rest of the command ran.

The token is only accepted over that VM's websocket (737b8c), so the risk is limited. But it shouldn't be in traces, and the self-kill wastes steps.

**What to build**

- Pass the token through the environment, not on the command line. Pass the command on stdin or in a file, not as an argument to `bash -lc`.

**Done when**

- [ ] A command running `ps -eo args` on the VM sees neither the token nor its own command text (test)
- [ ] `pkill -f <pattern-from-the-command>` no longer kills the calling shell (test)
- [ ] docs/design.md (§15) updated

## As built (2026-10-24)

`apps/winstond/src/exec.ts` now runs `bash -lc 'script=$(cat); exec </dev/null; eval "$script"'`. The real script arrives on stdin: `export` lines for the request's environment (the run token), then the command. Only the fixed base environment is still on the command line. The command itself still gets no stdin.

Environment names are checked, and values are single-quoted, so a quote in a value stays intact.

Tests in `exec.test.ts` (Linux only, run in `oven/bun:1.4.2` with procps):
- a process listing shows neither the token nor the command;
- `pkill -f` on the command's own words leaves its shell alive;
- no stdin, and quoting holds.

Against the old executor the first test fails with exit 143, the production symptom. docs/design.md §15 is updated.

- [x] A command running `ps -eo args` sees neither the token nor its own command text (test)
- [x] `pkill -f <pattern-from-the-command>` no longer kills the calling shell (test)
- [x] docs/design.md (§15) updated
