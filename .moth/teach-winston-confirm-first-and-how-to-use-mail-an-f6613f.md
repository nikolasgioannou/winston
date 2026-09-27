---
id: "f6613f"
title: Teach Winston confirm-first and how to use mail and calendar
status: todo
priority: none
labels:
  - m5
  - prompts
created_at: 2026-09-27T05:37:39.574Z
updated_at: 2026-09-27T05:37:39.645Z
blocked_by:
  - "837a29"
  - "c7b3fa"
  - "fe870e"
---

Winston can now act on the user's behalf, so the prompt must carry the soft layer of the trust model: **confirm in chat before external-facing actions** (product.md §6, docs/design.md §5 Permissions). The hard layer (permission toggles) is enforced by the server regardless.

Update the front-of-house prompt, best effort, staying static and generic:
- **Confirm-first:** before sending mail, inviting people, or changing or declining a shared meeting, show the user what will happen and wait for a yes. Use `--dry-run` to produce an exact preview. Private, easily undone actions (drafting, archiving, labeling, creating a hold on one's own calendar) don't need confirmation.
- **Assistant voice** when writing on the user's behalf, from their own account (product.md §6 Identity).
- **Accounts:** check `winston accounts list` when unsure which account applies, and respect the aliases.
- **Permission errors:** tell the user plainly what's disabled and where to enable it, and never try to work around a disabled capability, for example through the browser later.
- Brief reminders of the high-value habits: `winston calendar free` for scheduling, and reading a thread fully before replying.

Check by hand in production (or locally):
- Ask Winston to reply to an email. He shows a preview and waits.
- Ask him to archive something. He just does it.
- Disable `send` and ask again. He explains that sending is disabled.
