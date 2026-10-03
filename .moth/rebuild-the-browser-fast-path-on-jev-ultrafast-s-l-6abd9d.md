---
id: "6abd9d"
title: Rebuild the browser fast path on jev-ultrafast's loop
status: backlog
priority: none
labels:
  - browser
  - vm
created_at: 2026-10-03T17:26:02.878Z
updated_at: 2026-10-03T17:26:17.025Z
---

The founder (2026-10-03): "our browser use is just not good… learn from [browser-use/jev-ultrafast] and implement this exactly."

## Why

From the production trace review (5c3cdf) and the local browser runs (26dfa2):

- **Every browser step is a full LLM turn:** 3–10 s each on Sonnet 5 in the front of house, longer on Opus in tasks.
- **Autopilot was never chosen,** in five local tasks or in production. It clicks only and hands back the moment text needs typing, so most flows need the big model anyway.
- **Commands time out:** six browser commands in production were cut off by the front of house's 10-second command limit.
- **A real button refused as "covered":** on BA, the "covered?" check rejected a button inside a closed shadow root twice, until Winston clicked by coordinates.

jev-ultrafast (MIT, read in full on 2026-10-03 at commit `1231850`; about 850 lines of Python and JS) runs a real Google Flights search from one natural-language goal in **7.1 s**. It does Wikipedia in 2.8 s, with a median Jev decision of 178 ms. Its own history is instructive: an accessibility-tree snapshot (what `winstond` uses today) was slower, at 9.4–10.2 s for Flights. A single atomic DOM read in one browser call took it to 7.1 s, and protocol calls fell from 1,092 to 101.

## What jev-ultrafast does, which we copy

1. **Observation: one atomic DOM read** (`snapshot.js`, a single `Runtime.evaluate`).
   - **Which elements:** visible, enabled, in-viewport controls (`a[href]`, `button`, `input`, `textarea`, `select`, `summary`, `contenteditable`, and roles `button link checkbox radio switch tab menuitem menuitemradio option gridcell combobox textbox searchbox spinbutton`).
   - **Names and state:** names from `aria-labelledby` → `aria-label` → labels → button value → `alt` → text → `title` → `placeholder`; current values; checked/selected/expanded.
   - **Excluded:** `password`, `file` and `hidden` inputs.
   - **Size:** up to 250 candidates, plus up to 6,000 characters of *visible* text (offscreen bodies and footers never fill the context).
   - **Identity:** each node gets a code-owned id (a `WeakMap`), so the model never produces selectors, coordinates or code.
   - **Freshness:** the read also returns a semantic marker and per-target guards.
2. **Action space.** One index per element. Operations are offered only when something supports them: `CLICK`, `TYPE_TEXT` (editable fields), `SELECT` (one target per native option, `index:option`), `SCROLL_UP`/`SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`.
3. **One Jev request per step,** asking every question at once.
   - **The questions:** an `operation` choice, plus a target choice for *each* available operation (`click_target`, `type_text_target`, `select_target`). These are speculative heads, and only the head matching the chosen operation is executed.
   - **Validation:** the choice is in the set, probabilities sum to 1, and the choice is the maximum.
   - **State sent:** the page (`url`, `title`, visible `text`), the elements with values and states, and the last 10 actions.
   - **Instructions:** its `NEXT_ACTION` and `TARGET` rules (`questions.py`). Adapt them, keeping their substance: fill required fields before submitting, pick the autocomplete suggestion after typing, don't re-toggle a control already in the requested state, WAIT only when something is actually loading, DONE needs visible evidence.
4. **Typing.** `TYPE_TEXT` calls a small, fast LLM: they use `inception/mercury-2.5` on OpenRouter with reasoning off, which is on OpenRouter at $0.04/M in and $0.15/M out.
   - **Its job:** write `{"text": "…"}` from the goal, the field, the visible page text and the last 6 actions.
   - **Missing values:** `{"text": null}` when a needed value is missing. It never invents personal information.
   - **How it types:** click the field, issue the browser's select-all command, then `Input.insertText`, which replaces the old contents.
   - **Retries:** a generated value is reused only if the whole helper input is unchanged.
5. **Execution.**
   - **Freshness right before input:** click and select use scoped guards (document and URL, form values, the target itself, its nearby form/dialog/row text); everything else uses the full marker.
   - **Target checks:** re-read the current geometry, and reject hidden, disabled, offscreen or covered targets.
   - **Mutations:** never retried, and logged before the next observation.
6. **Waits.** After an action, at most 2 animation frames or 50 ms. After typing into a combobox, until its options are visible, at most 200 ms. `WAIT` is 100 ms. Focus emulation keeps background tabs rendering (we already do this for live views).
7. **Stopping.** `DONE` (never trusted alone; the caller verifies), `BLOCKED`, three actions in a row with no page change, or 60 actions / 120 decisions.

## How it fits Winston

- **`winston browser autopilot "<goal>"` becomes this loop,** rewritten in `apps/winstond/src/browser/autopilot.ts`.
  - **Jev:** goes through the existing proxy (`POST /v1/jev/decide`, OpenRouter's decisions API, `typesafe/jev-1.13`).
  - **The text helper:** a new backend route, e.g. `POST /v1/jev/text`, holds the OpenRouter key, so no key reaches the VM (§15). Its cost goes into `cost_ledger`; `jev_decisions` keeps logging every decision.
  - **Opus stays in charge:** it plans, writes the goal (including the values autopilot will need, such as names, dates and booking references), verifies the result with a snapshot, and does the handoffs.
- **Keep Winston's safety, adapted to the new action space:**
  - **Confirm-first.** jev-ultrafast stops before booking only because the goal says so. Add a `commits` choice head to the same request: "which of these targets, if clicked or selected, would place an order, pay, send a message, book, delete or otherwise commit something for the user, or none". It's speculative, so there's no extra round trip. If the chosen target is the one named, stop and hand back to Opus. This replaces today's name regex, which also blocks harmless "Search"/"Submit" clicks.
  - **Missing personal values:** a `null` from the text helper stops the run with "needs: <field>".
  - **Passwords:** never typed; password fields aren't even observed, so those flows go to a handoff.
  - **Bot checks and blocks:** show up as `BLOCKED` with the reason, and Opus hands off (the founder's decision, 2026-10-03; on the signed-in page of b8e28a that's one tap).
  - **Per-site reliability and the outcome signal** (91faf5) stay.
- **Hidden from the page.** Run the snapshot and executor scripts in our per-frame *isolated world* (`Page.createIsolatedWorld`, as `actions.ts` already does), not the page's main world. jev-ultrafast stores `window.__jevFast` where page scripts can see it, which is an easy bot signal (decision #23, research doc).
- **Frames and shadow DOM.** jev-ultrafast handles neither; our accessibility snapshot handles frames.
  - **First version:** the top document plus open shadow roots, traversed recursively.
  - **Frames:** a frame-heavy page returns `BLOCKED` ("controls inside a frame") and Opus uses `snapshot`.
  - **Extending:** to same-session frames once measured.
- **The "covered" bug.** Both executors (new and `actions.ts`) treat the element under the point as the target's own when it is a *composed* ancestor of the target, walking up through shadow hosts. Today a closed shadow root stops the hit test at the host (`hit.shadowRoot` is null), and `host.contains(inner)` is false across the boundary, so a real button reads as "covered by `<ba-link>`".
- **Making Winston use it.** The background prompt (and the front of house's short browser section) say to run autopilot for any multi-step stretch, with a precise goal that carries the values it needs, then check the result with a snapshot. Keep it principle-level, per ea2e27.
- **The front of house's 10-second limit.** An autopilot run takes 2–30 s. Decide between:
  - (a) letting a single `winston browser …` command run up to about 45 s in the front's `bash`; the turn waits and steering applies after it;
  - (b) the front delegating anything longer than a look.

  Measure typical autopilot durations first. Lean (a), with a `--max-seconds` budget on autopilot.
- **Measure, and decide about `snapshot`.**
  - **Speed:** time the new loop against today's autopilot and against Opus driving step by step, on a Google Flights search, a Wikipedia article and a local fixture (port their hotel fixture). Record the results in docs.
  - **`snapshot` for Opus:** also time the DOM read against our accessibility snapshot on five heavy sites. If it's faster and complete, base `winston browser snapshot` on it too (refs stay `eN`), keeping the accessibility path for frames. Decide after measuring.

## Tests

- **Port their offline tests** (`tests/test_agent.py`):
  - invalid choices are rejected;
  - one index per node, with operation-specific targets;
  - all heads go in one request, and only the matching head executes;
  - a click can't consume a typing target;
  - target heads get the control state;
  - invalid helper values are rejected;
  - a missing helper stops the run before guessing;
  - a stale decision is consumed before any mutation;
  - generated text is reused only for an identical context;
  - loading waits don't count as "no progress";
  - a stale observation keeps the executed action;
  - an observation is one atomic read;
  - the executor rejects a stale page before input;
  - an interrupted dropdown mutation isn't retried.
- **Port `scripts/check_guards.py` as a Chrome test:**
  - a moving target is clicked where it is now;
  - unrelated offscreen text doesn't invalidate;
  - changed label, field value, checkbox, disabled, read-only and hidden states, and a covering overlay, each block the click.
- **Add:**
  - the closed-shadow-root regression;
  - the `commits` head stopping a "Place order" click but not a "Search" click;
  - the isolated world leaving no globals on the page;
  - `BLOCKED` on a bot-check fixture.

## Docs

§5 Browser (autopilot as built), decision #24, docs/research/models-openrouter.md (Mercury), and the measurements.
