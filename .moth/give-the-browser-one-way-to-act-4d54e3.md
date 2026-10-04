---
id: "4d54e3"
title: Give the browser one way to act
status: done
priority: high
labels:
  - agents
  - browser
created_at: 2026-10-03T23:45:24.154Z
updated_at: 2026-10-04T01:39:11.935Z
blocked_by:
  - "fdf611"
---

From the founder (2026-10-03): Winston drives the browser two ways, and there shouldn't be two modes.

- **One command per action** (`click e25`, `type e46 "…"`, `select`, `press`, `scroll`): each is a full model turn, so it's flexible but slow (2–4 s an action, with the whole conversation as context).
- **`autopilot "<goal>"`:** Jev picks actions in a fraction of a second. When it's unsure, stuck, or Jev is down, it stops and hands control back, and the agent carries on one command at a time.

The agent chooses between them, often wrongly: on the founder's maintenance request the front of house filled in a whole form one command at a time.

## One way to act

- **`winston browser act "<instruction>"`** (Stagehand's name for it): a whole flow with its values, or a single step ("click New request"). It replaces `autopilot` and the per-element commands.
- **Each step goes to whoever can decide it:**
  - Jev, when it's confident.
  - Otherwise a model (Sonnet 5 at `low`) decides that one step. It sees the same compact page view, the instruction and the recent actions, and chooses from the same action space.
- **When a step escalates:**
  - Jev's confidence is below 0.5. In the one production run so far, Jev clicked "Leave now" three times at 0.81–0.87 with nothing changing, then floundered on a date picker at 0.25–0.43.
  - The last action changed nothing.
  - Jev says blocked, gives an answer that doesn't check out, or is unavailable.
  - The site is one where Jev keeps being overridden.
- **Keys:** Enter, Escape and Tab on the focused element join the action space (Enter in a search box, Escape to close a popup).
- **It stops only at boundaries:**
  - done;
  - before anything that commits (the agent decides, as now);
  - a value the instruction doesn't give;
  - a sign-in or bot check (a handoff);
  - stuck after the model tried too;
  - its limits.
- **The report ends with the page it left:** its title, address and visible text, so checking needs no snapshot.

## What goes away

- `click`, `type`, `select`, `press` and `scroll` by ref, with their code in winstond and their settle wait.
- Refs in `snapshot`, which is now for reading only; `wait --for` takes text only.
- **Kept:** `open`, `navigate`, `back`/`forward`, `snapshot`, `screenshot`, `eval`, `wait`, `dialog`, `close`, `windows` and `get`, and `click-xy` as the last resort for canvases and widgets nothing else can operate.

## Measure

- **Flows:** jev-ultrafast's fixture, Wikipedia and Google Flights (2.15 s, 2.45 s and 6.27 s in 6abd9d), the bot check and the checkout stop, and a form like the founder's maintenance request (selects, a textarea, a frame that never finishes loading).
- **Escalations:** how often steps escalate, and what escalated steps cost in time and money.

## Done when

- `act` is the only way to act, in the CLI and in both prompts, and the old commands are gone.
- The flows above pass, and the ones Jev handled alone are no slower than before.
- Docs: §5 Browser, §11 CLI, and the decision log.

## As built

- **`winston browser act "<instruction>"`** replaces `autopilot` and the per-element commands. Its route on winstond's socket is still `autopilot`, which daemons not yet restarted after an update know. Its new report fields are optional for the same reason.
- **The step picker** (`POST /v1/jev/pick` in `packages/vm-api/src/jev.ts`; `pickStep` in `autopilot.ts`): Sonnet 5 at `low`, pinned, keeping no data.
  - **What it gets:** the same page view, operations and recent actions as Jev, Jev's operation and target rules, why it's asked, and where the screen is on the page.
  - **Its answer:** `{operation, target, text, commits}`, the first JSON object it writes. It's checked against the page like Jev's. If it doesn't check out, Jev's pick stands, or Jev is asked when it wasn't.
  - **Logging:** `jev_decisions` (`question.picker`), charged as `jev`, and left out of a site's reliability.
- **When it's asked** (changed from the ticket after measuring):
  - **Asked:** Jev says blocked, gives an invalid answer, or is down; Jev wants to repeat a step that changed nothing; Jev says done below 0.5; every step on a site where Jev keeps being overridden.
  - **Not asked on confidence alone:** escalating every pick below 0.5 slowed routine flows 2–3× (hotel 2–4 s → 8–10 s) for no gain. Jev was right at 0.22–0.47 there, and its production loop came at 0.81–0.87.
  - **Its first answers** copied the commit question's "none" into the target. It now gets only the operation and target rules, and is told to pick another operation when no listed element fits.
- **Keys:** `PRESS_ENTER` while an editable field has focus, `PRESS_ESCAPE` while a menu, list or dialog is open. Both are sent to whatever has focus, frames included, and are candidates in the commit question.
- **`--commit`:** with the user's yes, the one committing step is taken, and the run stops as `committed`.
- **Report:** what it did, the stop, how many steps the picker decided, and the page it ended on (title, address, up to 1,500 characters).
- **Found while measuring, and fixed:**
  - **Covered controls aren't offered:** the read hit-tests each control's middle. A selected calendar cell behind a sliding panel on Google Flights was offered and refused 40 times in a row.
  - **A stale step is retried once on the fresh read** if its element is still there as it was, checking only that element and the document. Google Maps rewrites its address and live times every second, and each decided step was being thrown away.
  - **Done or blocked twice in a row** on two reads stands on a page that never stops changing.
- **Removed:**
  - `click`, `type`, `select`, `press` and `scroll`, with their code in winstond and the CLI;
  - refs in `snapshot`, now for reading only;
  - `wait --for <ref>`.
- **Kept:** `click-xy` as the last resort.
- **Known gap:** controls inside a closed shadow root (BA's check-in button) are invisible to `act`, as to any page script. The by-ref click that reached them is gone; `click-xy` from a screenshot reaches them.
- **Prompts:** both say to use `act` for everything done on a page, with every value it needs, and to read its report. `--commit` comes after the user's clear yes (front of house) or the brief's approval (background). `click-xy` only for what `act` can't operate.
- **Measured** (local Chrome, real Jev, Mercury and Sonnet, one run each):

  | Flow | Time | Result |
  |---|---|---|
  | Maintenance form like the founder's | 2.4–2.8 s | All six fields right; nothing escalated |
  | Hotel fixture | ~4 s | One escalation |
  | Wikipedia | 2.2–3.7 s | Correct |
  | Bot check | ~1 s | `blocked` |
  | Cart | 0.2–0.3 s | `commits` |
  | Google Maps "depart at 5 pm tomorrow" (Jev alone failed this in production) | 7–10 s, about $0.01–0.02 | Done; once with the date still today, which the report shows |
  | Google Flights | — | Failing since Google changed it to a multi-airport picker, with or without the step picker or keys, as Jev alone does |

Tests:
- **Escalation:** each trigger and non-trigger, the request, validation and fallback, text, `--commit`, keys, the stale retry, done twice, and the loose freshness check.
- **Real Chrome:** Enter and Escape; covered controls left out.
- **Backend:** the `/pick` route, the parser, failures, and reliability.
- **CLI:** `act`, the removed verbs and `wait`.
- **Snapshots:** goldens without refs.

Docs: §1, §5 Browser (one way to act, the step picker, the loop, measured, tests, prompts, covered across shadow roots), §6 failure handling, §11 CLI reference, snapshots and actions, decision #79 (new), the Jev risk; research/models-openrouter.md (the step picker); runbooks/costs.md and secrets.md.
