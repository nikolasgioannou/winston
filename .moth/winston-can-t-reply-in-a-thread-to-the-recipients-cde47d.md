---
id: "cde47d"
title: Winston can't reply in a thread to the recipients the user picks
status: todo
priority: high
labels:
  - mail
parent: "07ba81"
created_at: 2026-10-24T16:49:56.707Z
updated_at: 2026-10-24T16:50:33.244Z
---

`winston mail reply` takes only `--all`: it can't change To/Cc/Bcc or the sending account. `mail send` can't reply into a thread. So when the user asks for specific recipients on a reply, Winston sends a new thread.

**From the trace audit (07ba81):**

- **Oct 16, 09:38:** asked to reply to Cory's Z Fellows intro, Nik wanted "move those guys to the [to], Marc to cc, Cory to cc as well". Winston used `mail send --subject "Re: Intro"`. The preview didn't say it would leave the thread. Nik: "why didn't it respond on thread" / "It made a new thread instead". Runs `run_01m51402maeh1b7b4kxat79cf8`, `run_01m52ezfwyeh1b7b87rtckfp58`.
- **Oct 13, 15:51:** `mail reply … --account` returned "Unknown flag `--account`". The prompt says mail commands take `--account` for Winston's own address.

**What to build**

- `winston mail reply <msg|thr> --to/--cc/--bcc` (repeatable). These replace the default recipients and keep In-Reply-To/References, so the reply stays in the thread. `--all` stays as the shortcut.
- `mail reply --account`, validated against the thread's account.
- `--dry-run` shows the thread the reply joins.
- The API, CLI help, front-of-house and background prompts, and docs/design.md (the mail section) updated.

**Done when**

- [ ] A reply with `--to`/`--cc` is sent in the original thread with exactly those recipients (test against the Gmail connector fake)
- [ ] `reply --account` works for Winston's own address and refuses an address that isn't the thread's (test)
- [ ] Replay of the Cory request: previews and sends in-thread with Nik's recipients (3/3)
- [ ] docs/design.md updated
