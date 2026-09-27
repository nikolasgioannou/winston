---
id: "bbfa17"
title: Teach the front of house about its computer
status: todo
priority: none
labels:
  - m2
  - prompts
created_at: 2026-09-27T05:32:52.145Z
updated_at: 2026-09-27T05:32:52.212Z
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
