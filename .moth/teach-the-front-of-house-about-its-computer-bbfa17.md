---
id: "bbfa17"
title: Teach the front of house about its computer
status: done
priority: none
labels:
  - m2
  - prompts
created_at: 2026-09-27T05:32:52.145Z
updated_at: 2026-09-28T05:41:50.490Z
blocked_by:
  - "68e9cc"
  - "737b8c"
  - "ae2a73"
---

Now that Winston has a computer, the front-of-house prompt needs to explain how to use it (docs/design.md §2 memory, §5 tools, §11 CLI). Update the static system prompt, best effort:
- **The computer.** It's his own Linux machine. `bash` runs commands there, and `view_image` looks at images.
- **The `winston` CLI.** The conventions (noun then verb, `--help` with examples, bounded output), and the rule: **run `--help` when unsure rather than guessing.** Keep command specifics out of the prompt, since `--help` is the source of truth and the prompt must stay static and small.
- **Memory is files.** Notes live on the computer, organized however he likes. Write things down as they happen, because the conversation window scrolls away. Re-read a file right before editing it. Prefer small appends and targeted edits (§2, Durable memory).
- **When to consult notes:** before acting on events, and when a person or topic comes up.
- **Timeouts:** keep commands quick. Anything long belongs in a background task (delegation arrives in M6, so phrase this so it holds either way).

Also add **"Winston's home layout"** conventions to the image, so the prompt can reference them: `~/notes/` (suggested, not enforced), `~/inbox/` for received files, `~/downloads/`.

Check it by hand with `bun dev`:
- Tell Winston a preference, and confirm he writes a note.
- Start a new conversation window (reset `window_start_message_id`), and confirm he finds the note.

## Outcome

- Front-of-house prompt: "Your computer" (the machine, `bash`, `view_image`, 10 s commands, the home layout), "The `winston` command" (noun-verb, `--help` over guessing, bounded output), "Your memory is files" (write down when learned, check `~/notes/preferences.md` and search the rest before answering anything about the user's plans or people, re-read before editing, small appends, don't announce notes), and "What you can't do yet" now says to check notes before declining and never to offer reminders.
- Image: `~/notes`, `~/inbox` and `~/downloads` are created at boot by `systemd-tmpfiles`, since the data volume hides anything baked into `/home/winston`.
- Checked by hand: a stated preference was written to `~/notes/preferences.md` with a dated entry. After resetting the window, "book me a 9am call with Dana" first got no notes check at all; prompt iterations measured by eval raised that to 4/5 checks and 3/5 mentioning the 10am rule. Live, he checked but searched only for "dana" and missed `preferences.md`. Accepted for now by the user; prompt tuning continues with real use.
