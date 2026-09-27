---
id: "837a29"
title: Add winston mail send, reply, forward, update and delete
status: todo
priority: none
labels:
  - cli
  - m5
created_at: 2026-09-27T05:37:39.285Z
updated_at: 2026-09-27T05:37:39.337Z
blocked_by:
  - "d66d10"
  - "fc5532"
---

The write half of `winston mail` (docs/design.md §11 Command reference). Flags as specified there:
- `--to`, `--cc` and `--bcc` are repeatable.
- `--body` takes text, `-` for stdin, or `@path`, since heredocs are how agents write bodies.
- `--attach` is repeatable, `--draft`, and `--dry-run` on every write.

Output of a real write prints the resulting object and its id: the sent message id and thread, the draft id, the updated labels. `--dry-run` prints a clearly marked preview:
```
DRY RUN (nothing sent)
from: me@… (personal)  to: dana@…  subject: Re: Lease renewal
Tuesday works. Thanks, Dana.
```

`--help` examples should show the common agent flows: reply with a heredoc body, save as a draft, archive several messages, and preview before sending.

Tests: argument validation (missing `--to`, conflicting flags), stdin and `@file` bodies, dry-run output snapshots, and exit code 3 when `send` is disabled but `--draft` works.
