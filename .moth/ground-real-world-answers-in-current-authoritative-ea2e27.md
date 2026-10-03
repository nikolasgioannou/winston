---
id: "ea2e27"
title: Ground real-world answers in current, authoritative sources
status: backlog
priority: none
labels:
  - agents
  - prompts
created_at: 2026-10-03T17:26:02.813Z
updated_at: 2026-10-03T17:26:17.151Z
---

From the production trace review (5c3cdf, 2026-10-03). The mistakes that cost the founder real time:

1. **A drive time from the wrong moment.** He planned the Strokes trip with Google Maps' estimate at 1:38 am (23 min) for a 5–6 pm departure. With traffic it took about 50 min, and the founder walked 40 more.
2. **A fan post over the founder's own email.** Set times came from a Reddit comment (Beach House 6:45). The official Bowery Presents email in the inbox said 6:30.
3. **Stale emails over the calendar.** He told the founder the flight was Oct 6 from EWR, based on August booking invites. The current booking was in that morning's email, in image-only PDF attachments he hadn't opened. The calendar was right.
4. **A slot that had already passed.** He offered "3:30–6 pm today" for a haircut at 6:12 pm.
5. **Promises with nothing behind them.** "I'll check again in a bit and let you know"; "I'll let you know the moment it's back"; "once you land I'll switch your timezone to Cyprus (standard practice)". No trigger was set for any of them.

He apologised well and wrote corrective rules into his own notes. But each lesson was learned after the fact, and only for that one case.

## The founder's constraint

No prompt line per failure ("for trips, use Maps' depart-at time"). That overfits: it fixes the five cases we saw, not the next five. Fix the causes in a way that generalises.

## The causes, stated generally

- **Time validity:** facts that depend on *when* (traffic, opening hours, schedules, availability, prices, what's still ahead today) were used for a different time than the one they're about.
- **Source authority:** a weaker source (a fan post, a stale email) beat a better one the user already has (their own mail, calendar, attachments, notes) or an official one.
- **Conflicts:** when sources disagreed, he asserted one instead of reconciling them (the newest, most specific one usually wins) or asking.
- **Commitments:** a future action promised without the thing that makes it happen (a trigger) being set in the same turn.

## Approach

1. **Replay evals from real failures,** so changes are measured, not guessed. Every model call records its prompt version (`model_calls.prompt_hash` → `prompt_versions.content`) and the exact context it saw (`context_from_message_id` … `context_to_message_id` in `run_messages`).
   - A script reconstructs a failing call's context the way the window builder did, swaps in a candidate prompt or model, re-runs that one call, and has an LLM judge score the next action against a rubric for its cause.
   - **Cases:** the five production failures above, plus held-out variants written to test the same causes in other domains, so we can tell a principle from an overfit rule. For example: a restaurant's opening hours on a holiday; a doctor's confirmation email that moved an appointment the calendar still shows at the old time; a delivery window; a train time; a meeting invite updated by a later email; "remind me when the package ships" with no trigger set.
   - Runs locally with the dev key (paid; not in CI). Production contexts are the founder's data: the script reads them with their go-ahead, and any copied fixtures stay out of git.
2. **Principle-level prompt changes,** a few lines each in the front-of-house and background prompts, in their existing voice. The spirit: what's true depends on *when* and on *who says it*. Use information valid for the time it's about; prefer the user's own records and official sources; when sources disagree, the newest specific one wins, and say so when it matters; never promise a future action without setting what makes it happen. The exact wording is whatever scores best on the replays, including the held-out cases.
3. **Test the model lever too.** The front of house runs Sonnet 5 at low effort (`modelProfiles` in `apps/agents/src/model/gateway.ts`), and several failures look like reasoning shortcuts. Replay the same cases at higher effort and on Opus 5.5 to see how much is capability and how much is instruction. Record the cost trade-off before changing the default.
4. **His own notes:** he added rules to `~/notes/preferences.md` (time-specific Maps estimates, email first for things the user booked, a recheck trigger for travel blocks). Check whether the principles make them redundant; leave the notes alone either way, since they're his.

## Done when

The production failures and the held-out variants pass on replay at a rate agreed with the founder, with no per-case rules added to the prompts. Record the before/after scores and the model comparison in docs/design.md, next to the first prompt review (62e3d2).

Related: e19be9 (`calendar free` never offering the past) and feebd3 (less chattiness; its prompt change touches the same sections).
