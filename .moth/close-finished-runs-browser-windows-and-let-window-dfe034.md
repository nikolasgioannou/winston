---
id: "dfe034"
title: Close finished runs' browser windows and let windows change hands
status: done
priority: none
labels:
  - agents
  - browser
created_at: 2026-10-03T17:26:02.910Z
updated_at: 2026-10-03T18:59:59.913Z
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

## As built

1. **An ended task's windows close at once.**
   - `finishTask` queues `close_task_browser` in the same transaction as the final status (completed, failed, capped, cancelled), so every way a run ends is covered: agents, `winston task cancel` through the VM API, and cancelling a parked task.
   - The job asks the gateway (`/browser/release` with `close`), which ends any live view ("The task ended.") and sends `browser.release` with `close: true`. winstond's `closeOwner` closes the run's windows, held ones included, and frees its sites.
   - It's retried while the computer is away (409, five attempts). A user with no computer has nothing to close. A parked run isn't ended, so its windows stay.
2. **A window can change hands.**
   - `delegate` takes an optional `window` (an id; it's an input, not a new tool, so invariant 6 holds). The tool makes the task's id first, has winstond give the window to it (`browser.transfer`, answered with `browser.transferred`), and only then queues the task. So the task owns the window before its first step, and its brief gains a line naming the window and its page.
   - winstond keeps the tab, session and history and moves the window's site locks. It makes it the task's current window and clears the old owner's refs, and the front of house can then only look at it.
   - A window that isn't the front's, or that the user holds, isn't given ("Not started: … isn't a window of yours to hand over"), and the task doesn't start.
   - **Prompts:** the front of house's browser section says to give a task its window to carry on a page, and the background prompt mentions a handed-over window.
3. **A blank window isn't handed over.**
   - **What counts as blank:** `about:blank`, a new tab, or `chrome-error://`. Both handoff paths let the hold go and answer with "Not handed over: your browser window is blank… Open the page they need first", or close it if the user's part isn't in the browser.
   - **The front of house's turn continues:** the turn now ends only when a handoff actually went through.
   - **A task carries on instead of parking,** including in the crash-recovery path.
   - **Error pages:** Chrome usually reports the attempted URL for an error page, so those are caught only when the URL shows `chrome-error://`. The navigation itself already reports the failure.

Tests:
- **winstond:** closing an ended owner's windows (held ones too) and freeing its sites; a transfer keeps the page and site and becomes the new owner's current window, the giver is refused, and nothing or a held window can't be given.
- **gateway:** transfer request and reply; close sent, or 409 while offline.
- **agents:**
  - the close job, including not-found and retry;
  - a refused blank handoff, in a task and in the front of house;
  - a delegated window, transferred before the task, with the brief note, and a refused one;
  - `close_task_browser` queued when a run finishes.

Docs: §5 (handoff, windows changing hands, cleanup, locks), §5 native tools table, §9 job types, §15 frames, decision #23.
