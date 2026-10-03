---
id: "dfe034"
title: Close finished runs' browser windows and let windows change hands
status: backlog
priority: none
labels:
  - agents
  - browser
created_at: 2026-10-03T17:26:02.910Z
updated_at: 2026-10-03T17:26:17.109Z
---

From the production trace review (5c3cdf, 2026-10-03), the BA check-in on the night of Oct 2. Three gaps in how browser windows belong to runs.

## 1. A finished task keeps its windows and site locks

The 10:30 pm check-in retry finished (`task.completed`), but one of its two windows stayed open on BA's error page, and so did its `britishairways.com` lock. When the founder wrote "Send me the browser, I'll take over", the front of house hit "britishairways.com is in use by task …, for up to 1 more min" four times over about a minute, while `winston task list` said nothing was running.

**Cause:** only the front of house releases its browser, when the user writes (`apps/agents/src/front/turn.ts`, `releaseBrowser`). A background run's windows wait for the idle sweep (30 minutes unused *and* the run's token expired, `windows.ts` `sweep`), and their locks live until those windows close.

**Fix:** when a background run ends (completed, failed, capped or cancelled; wherever `run-state` moves it to a final status), agents tells the VM to close that owner's windows and drop its locks. That's a new gateway call and frame alongside `browser.release`, or `release` gains a `close` option. Parked runs keep theirs (a handoff may be live).

## 2. A task can't take over the front of house's window

After the founder and Winston got BA's check-in to the passport page in the front of house's window, Winston delegated: "continue … in the user's browser window win_…". But a run can only *look at* another owner's window. The task opened new windows, lost BA's session ("check-in not available") and was blocked. Its report says so plainly.

**Fix:** let a window change hands.
- `delegate` gains an optional `window` (the front of house's current window by default when it says so). The new task starts owning it: winstond reassigns the owner, keeps the CDP session, cookies, history and locks, and makes it the task's current window.
- **This changes a native tool's input,** not the tool set, so invariant 6 holds. The description says when to use it: hand over a page mid-flow so the task can continue it.
- **Without it,** the prompt must say plainly that a task can't use the front's window, so briefs stop asking for it.

## 3. Never hand over a blank window

Because of the stale lock, Winston handed the founder his `about:blank` window. The live view showed an empty screen ("It's just showing empty screen"), and he only then loaded BA.

**Fix:** `browser_handoff` refuses a window on `about:blank` or a browser error page, with "your window is blank: open the page first, then hand it over". The handoff stays the model's call; this just stops the empty case.

## Notes

- The signed-in live view (b8e28a) changes how the founder sees and takes over windows. These fixes are needed either way: locks and ownership live in winstond, not the page.
- Docs: §5 (windows, locks and handoff as built), decision #23 if window ownership rules change.

Tests: a completed or failed task's windows close and its locks release, while a parked task's stay; a delegated window keeps its URL, cookies and session under its new owner; the front can't act in it afterwards; a blank window can't be handed over.
