---
id: "323fc2"
title: Winston can't upload files to websites
status: done
priority: high
labels:
  - agents
  - browser
created_at: 2026-10-04T20:51:10.443Z
updated_at: 2026-10-04T21:05:28.329Z
---

From production (2026-10-04): the founder asked Winston to put 7 receipt PDFs from `~/downloads/…` into a Google Drive folder for the Halcyon reimbursement form. `act` clicked New → File upload about ten times, each click opening Chrome's native file picker, which no browser command can see or operate. The page kept changing (the menu opening and closing), so it never stopped as `no_progress`. Winston handed the window over, and the founder couldn't upload either: the browser page streams the tab, not the picker, and the files are on the VM, not the founder's phone. It ended with "upload them from your phone".

Nothing in winstond sets a file input. `eval` can't either: page scripts can't set a file input's files.

**What to build**

- Intercept file pickers in every window (`Page.setInterceptFileChooserDialog`), the page's own session and its cross-site frames', so Chrome never opens its native picker. Record the one that opened on the window (`Page.fileChooserOpened`: the input, single or multiple), like a waiting dialog.
- `act` stops as soon as the page asks for files, as `blocked`, saying to give them with `winston browser upload`; `click-xy` and other actions report it the way they report a dialog.
- `winston browser upload <path…>` gives the waiting picker files from Winston's computer (`DOM.setFileInputFiles`). Paths are checked first: each must be a file inside the home folder; a single-file input takes one. Then it reports like other actions.
- Prompts: when a page wants files, click its upload control with `act`, then `upload` the paths.

**Done when**

- [x] In real Chrome, clicking a file input (plain, hidden and clicked from script like Drive's, and multiple) records the picker without opening a native one, and `upload` puts the files in it with `change` fired.
- [x] `act` stops at a picker instead of clicking again.
- [x] `upload` refuses missing files, directories, paths outside home, several files for a single input, and no picker waiting, each with a clear message.
- [x] Docs: §5 Browser and §11 CLI.

## As built

- **Interception** (`windows.ts`): `Page.setInterceptFileChooserDialog` on each window's session as it's attached, and on each cross-site frame's as it auto-attaches. Frames also need `Page.enable` on their own session, or Chrome never reports their pickers (checked in Chrome 154). `Page.fileChooserOpened` records the input's `backendNodeId`, the session it came from and whether it takes several files on the window (`fileChooser`); a new document in the window drops it. A picker that isn't a file input (no `backendNodeId`, e.g. `showOpenFilePicker`) isn't recorded.
- **Side effect, handled:** with `Page.enable` on frames, confirms and prompts inside cross-site frames now reach winstond too, so a dialog remembers its session and `dialog` answers it there.
- **Reporting:** the action that opened a picker reports `fileChooser: { multiple }` (optional in the response, for older daemons), and the CLI says to `upload`. Each action and each `act` run starts by dropping a picker left from before, so only what it opened counts. `act` stops as `blocked` with "The page is asking for files…: give them with winston browser upload <path…>." (no new stop kind, as for dialogs).
- **`winston browser upload <path…>`** (route `upload`, an acting route for Jev's outcome): the CLI makes paths absolute (`~/` is home, the rest from its working directory); winstond checks every path with `locateFile` (split out of `openForRead` in `file-ops.ts`: inside `/home/winston` with symlinks followed, and a file), refuses several for a single input, names every problem at once and gives nothing if any fails, then `DOM.setFileInputFiles` in the picker's session. An input that went away says to click the upload control again. No size limit: Chrome reads the files itself, as `winston`.
- **Prompts:** background: have `act` click the upload control, then `upload <path…>` (the user's files are in `~/inbox/`), never hand an upload to the user. Front of house: the same in a sentence.
- **Probed first** in a throwaway headless Chrome 154: single, multiple and script-made inputs (Drive's pattern) all report the picker on the page's session, a second click reports another, `setFileInputFiles` fires `change`, and a cross-site frame's input works through its own session once its Page domain is on.
- **Tests:** windows (interception on page and frame sessions, the report, every refusal, files given in the right session, a new document dropping the picker, a gone input, a frame's confirm answered in the frame); autopilot (stops at the picker after one click, ignores one left from before); CLI (paths, output, usage); real Chrome (`fixtures/upload.html`: single, multiple, script-made and cross-site frame inputs, each filled and its `change` seen). Run against a local headless Chrome 154; `WINSTON_TEST_FIXTURES` says where Chrome sees the fixtures.
- **Not yet checked:** on the VM's headful Chrome and in production, which needs a deploy (and a VM restart of winstond, which self-updates).

Docs: §5 Browser (one way to act, prompt guidance, the browser page), §11 CLI (reference, acting commands, actions as built: dialogs and file pickers, tests), decision #80.
