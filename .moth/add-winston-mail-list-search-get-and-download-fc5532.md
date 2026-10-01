---
id: "fc5532"
title: Add winston mail list, search, get and download
status: done
priority: none
labels:
  - cli
  - m5
created_at: 2026-09-27T05:37:39.165Z
updated_at: 2026-10-01T16:20:34.270Z
blocked_by:
  - "253db2"
  - "6af84b"
---

The read half of `winston mail`, following the conventions exactly (docs/design.md §11): standard verbs, standard flags, bounded output with a footer, and exit codes.

- **`mail list` and `mail search [<text>]`:** one line per message, in the format from §11:
  `msg_7Hq2  2026-09-25 16:02 -04:00  Dana Reyes <dana@…>  Re: Lease renewal  [inbox, unread, 📎]  thr_91a`
  Times are in the user's time zone. Output is bounded with a `… N more. Use --cursor …` footer.
- **`mail get <msg_id|thr_id>`:** headers and body text. For a thread, messages in order with clear separators. Long bodies are truncated, with a note on how to see more. Decide the mechanism, for example `--full`, or the output saved to a file, and keep it consistent with `bash` truncation.
- **`mail download <att_id>… [--to <dir>]`:** prints the saved paths.
- `--help` for each verb includes 2–3 **real examples**, since agents learn the CLI from `--help` (§11 Discoverability).

Tests: output formatting snapshots, footers and truncation, `--json` shapes, and the exit codes for no account, ambiguous account, disabled capability and expired auth. Use a fake API.

**Done (2026-10-01):** long bodies stop at 3,000 characters per message with a note naming `--full`. Mail responses carry the user's time zone so the CLI formats times without another call.
