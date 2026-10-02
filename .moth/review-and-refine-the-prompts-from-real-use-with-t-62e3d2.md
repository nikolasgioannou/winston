---
id: "62e3d2"
title: Review and refine the prompts from real use (with the founder)
status: done
priority: none
labels:
  - collab
  - m9
  - prompts
created_at: 2026-09-27T05:42:36.330Z
updated_at: 2026-10-02T18:20:53.529Z
blocked_by:
  - "26dfa2"
  - "35c1ed"
  - "fa537d"
---

Every prompt so far was a best-effort draft written in the ticket that needed it. Refinement was always meant to come from real use (docs/design.md §1, Prompts live in the repo). By now there's a meaningful record in the database: model calls, run messages, silent turns, handoffs, event runs, and the founder's reactions.

With the founder:
- Pull examples from the database log of where Winston was too chatty, too quiet, got confirm-first wrong, wrote weak briefs, forgot to check notes, set up poor triggers, or wasted steps in the browser. Use the cost report too, to find expensive patterns.
- Rewrite the front-of-house, background and compaction prompts with those lessons. Keep them static and lean, and move command detail into `--help` wherever the prompt is carrying CLI specifics.
- Check the tool descriptions (`end_turn`, `attach`, `delegate`, `bash`, `view_image`, `browser_handoff`) as carefully as the prompts. They're prompts too.

Each prompt change produces a new `prompt_versions` hash automatically, so before-and-after behaviour stays traceable in the log. Done when the founder is happy with how Winston behaves day to day.

## As built

Done autonomously at the founder's request (2026-10-02); further rounds come from their feedback as they use Winston.

- **Evidence:** production traces reviewed this session (good work on the flight calendar, notes and check-in trigger; but during the deploy outage Winston promised "I'll update your notes … as soon as it's back" and "I'll let you know the moment it's back up", and said "on my end"), the local run log (front-of-house relays were short and right; the welcome lines fine), the five browser runs of 26dfa2, and the cost report (browser tasks $0.03–0.19; nothing pathological).
- **Front of house:** "When something fails" moved from the end of the prompt to right after the capabilities, with the forbidden phrases quoted and what to do instead (say what didn't happen, ask them to message again); an unreachable computer usually lasts a minute or two.
- **Background:** blocked sites: one other way in, then report; never sleep for minutes, retry after ~30 s a couple of times.
- **Compaction:** the current state includes open browser windows and anything handed to the user.
- **Tool descriptions** (`end_turn`, `attach`, `delegate`, `bash`, `view_image`, `browser_handoff`) reviewed; they match the prompts and stay.
