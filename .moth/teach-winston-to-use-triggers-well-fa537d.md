---
id: "fa537d"
title: Teach Winston to use triggers well
status: todo
priority: none
labels:
  - m7
  - prompts
created_at: 2026-09-27T05:40:24.960Z
updated_at: 2026-09-27T05:40:25.035Z
blocked_by:
  - "0512b5"
  - "4da088"
  - "595766"
---

Proactivity is emergent. There's no meeting-reminder feature, only Winston choosing to set up triggers (product.md §3, docs/design.md §3). That makes the prompt guidance here unusually important. Update both system prompts, best effort:
- **Notes to your future self are self-contained:** say what to do and why, and which notes to check. For example, "check notes on Sam's meeting preferences before pinging."
- **Pick the right trigger:**
  - A schedule for time-based things.
  - A filtered subscription for categories of events (for example, important mail with filters Winston works out, rather than every message).
  - `calendar.event.starting` with a lead time for heads-ups.
  - **A scoped one-shot with `--expires` and `--on-expire` for follow-ups:** "tell me when Dana replies, and if she hasn't by Friday, offer a nudge." This is how Winston notices when something *doesn't* happen.
- **Preferences drive triggers:** when the user says "give me a heads-up before external meetings," set up the subscription *and* write the preference in notes.
- **Event runs should usually end quietly.** Only surface what's worth the user's attention.
- Clean up triggers that are no longer relevant.

Check by hand in production:
- Ask for a heads-up before meetings with external attendees, and watch it fire.
- Ask to be told when a specific person replies, with a follow-up deadline, and exercise both paths.
