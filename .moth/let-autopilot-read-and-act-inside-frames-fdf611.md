---
id: "fdf611"
title: Let autopilot read and act inside frames
status: done
priority: high
labels:
  - browser
created_at: 2026-10-03T23:45:24.187Z
updated_at: 2026-10-03T23:52:12.133Z
---

Needed before the browser gets one way to act: autopilot's page reader skips frames. Controls inside them (booking and ticket widgets, some cookie banners, embedded forms) are reachable today only through the per-element commands, which that change removes.

## Approach

- **Reading:** each visible frame directly in the page, same-site or cross-site, is read with the same script, in that frame's isolated world. Cross-site frames have sessions of their own, as in snapshots. The frame's visible part is its viewport.
- **One action space across frames:** elements get page-wide ids, and each knows its frame.
- **Input in a frame:**
  - The target's point in the frame is added to the frame's position on the page (read again right before input). It's sent to the page as now, and Chrome routes it into the frame.
  - Typing goes to the focused frame.
  - Selects run in place, in the frame.
- **Freshness** checks per frame. The page's text includes each frame's, labeled.
- **Nested frames:** frames inside frames stay unread and counted, as now.

## Done when

- Real-Chrome tests cover a same-site frame and a cross-site frame (two local origins), with a click, a fill and a select inside each.
- Docs: §5 Browser.

## As built

- **Reading** (`fast-page.ts`):
  - The page read reports how many frames show. Only then does it look for them: `Page.getFrameTree` (same-site frames, nested ones included) plus the window's cross-site frame sessions, each frame's `<iframe>` (`DOM.getFrameOwner`) and its content box (`DOM.getBoxModel`).
  - It reads at most 6 frames showing at least 5,000 px², largest first, each with the same script in its own isolated world. The script takes the part on screen as its viewport and offers no scroll or wait controls in a frame.
  - A page without frames still costs one `Runtime.evaluate`.
- **One action space:** frame controls get page-wide ids and a `frame` index into `FastPage.framed`, which holds each frame's session, frame id, `<iframe>`, view, name, page key and marker. Guards are keyed `frame:node`. `actionSpace` keys elements by frame and node, since node ids repeat across documents.
- **Text:** each frame's text follows the page's as `[In a frame: <title or host>]`, up to 1,500 characters.
- **Freshness:** a click or select checks its frame's own guards, and a fill checks its frame's marker. Done and blocked check the page's marker and every frame's.
- **Input:** the target's point is offset by where the frame's content box is now (read again right before input; a frame gone or off screen is stale). Selects run in place in the frame. Typing goes to the focused frame.
- **Counted, not read:** frames inside unreadable frames, and ones that failed to read.
- **Measured** (local Chrome, real Jev): hotel fixture 2.3–4.3 s, Wikipedia 2.6 s, Flights 7.0–10.0 s. All three were correct; the spread comes from the text helper's latency.

Tests:
- **Real Chrome:** a page with a same-site frame and a cross-site frame on `localhost`, which Chrome runs in its own renderer (asserted). It clicks and fills in the first, and selects, fills and clicks a button in the second (the result read back from the frame's text), then clicks a page button alongside.
- **Unit and Chrome suites:** pass unchanged.

Docs: §5 Browser (the read, execution, stopping, measured).
