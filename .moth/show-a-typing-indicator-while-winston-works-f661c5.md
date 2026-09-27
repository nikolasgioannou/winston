---
id: "f661c5"
title: Show a typing indicator while Winston works
status: done
priority: none
labels:
  - m1
  - telegram
created_at: 2026-09-27T05:30:54.902Z
updated_at: 2026-09-27T22:08:56.713Z
blocked_by:
  - "cb9674"
---

Replies aren't streamed, so the typing indicator is the user's only sign that Winston is working (docs/design.md §4, Steering). Telegram's `sendChatAction: typing` expires after about 5 seconds.

While a front-of-house turn is running, send `typing` immediately, then re-send every ~4 s until the turn ends, whether by success, silence or error. It must never keep "typing" after the turn is over, including when the turn throws. Silent turns (`no_reply`) are common, so check how it feels: showing "typing…" and then sending nothing may look odd. Decide with a light touch, for example only starting the indicator once the model has produced its first step, or accepting a brief flash. Note the choice in §4.

Test the timer logic with fake timers: starts, repeats, and stops on success, silence and exceptions.

## Outcome

Built as described in docs/design.md §4 (Steering).
- **When it starts:** the indicator starts immediately, accepting a brief flash on silent turns. Starting after the first step would show it only once most replies are ready, and a delay can't tell silent turns from replies.
- **Telegram limitation:** Telegram has no way to cancel the indicator, so after a silent turn it fades within about 5 s. That's documented.
- **Tests:** timers are injected (`startTyping(send, logger, timers)`), so the indicator's own tests and the turn's tests check start, repeat and stop without real waiting.
