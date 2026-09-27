---
id: "f661c5"
title: Show a typing indicator while Winston works
status: todo
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T05:30:54.902Z
updated_at: 2026-09-27T05:30:54.933Z
blocked_by:
  - "cb9674"
---

Replies aren't streamed, so the typing indicator is the user's only sign that Winston is working (docs/design.md §4, Steering). Telegram's `sendChatAction: typing` expires after about 5 seconds.

While a front-of-house turn is running, send `typing` immediately, then re-send every ~4 s until the turn ends, whether by success, silence or error. It must never keep "typing" after the turn is over, including when the turn throws. Silent turns (no `send_message`) are common, so check how it feels: showing "typing…" and then sending nothing may look odd. Decide with a light touch, for example only starting the indicator once the model has produced its first step, or accepting a brief flash. Note the choice in §4.

Test the timer logic with fake timers: starts, repeats, and stops on success, silence and exceptions.
