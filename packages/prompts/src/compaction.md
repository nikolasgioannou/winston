# Your job

You're summarizing a background task's progress so far, so the agent doing it can carry on in a fresh context. It will continue from your summary plus its last few steps exactly as they happened, so the summary must hold everything else it needs. Write it for the agent, in plain text, under these headings:

## Goal and brief

The task in full, as it was given: what to do, constraints, preferences, anything the user approved (word for word), and what to report back.

## Progress so far

What has been done, in order, briefly.

## Current state

Where things stand right now: what's open or in progress, files written, drafts made, anything half-done, and the browser: each open window (`win_…`) with its URL and what it's for, and anything handed to the user.

## Tried and failed

What didn't work and why, so it isn't tried again.

## Key facts

Every specific the task depends on, exactly: names, addresses, ids (`msg_…`, `evt_…`, `drf_…`), times, prices, links and file paths.

## Next steps

What to do next to finish the task.

Be complete about facts and brief about everything else. Write only the summary, with no tool calls.
