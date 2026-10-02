---
id: "f0507c"
title: Create handoff links and stream a tab's screencast
status: done
priority: none
labels:
  - backend
  - browser
  - m8
created_at: 2026-09-27T05:42:03.904Z
updated_at: 2026-10-02T02:47:03.738Z
blocked_by:
  - "6b73c4"
  - "ac0f5f"
---

When Winston gets stuck (a login, a CAPTCHA, 2FA, an ambiguous choice), he sends a link. The user opens a live view of **that one tab** and takes over (product.md §4, docs/design.md §5 Browser, §15, §17 Handoff).

Build the backend side:
- **`browser_handoff(reason)`** (native tool, from the parking ticket) now also creates a `handoffs` row for the run's current window: the CDP target id, and a random token (hash stored) with a **~15 minute connect deadline**, **single use**, bound to that target. It produces the link `https://runwinston.com/t/<token>`. The link goes into the `task.needs_user` item for background runs, or straight into the front of house's context for its own handoffs, so it can be sent.
- **Screencast path:** the web page connects a websocket to `gateway`, presenting the token. `gateway` validates it (unexpired, unused, belongs to the target), marks it `connected` (consumed), and asks `winstond` to `screencast.start` on that target. `winstond` runs `Page.startScreencast`, acknowledges frames, and streams them as binary `screencast.frame` messages. `gateway` relays them to the page. Input events from the page (`input` frames) go back the same way, and `winstond` dispatches them with CDP `Input.*`.
- **Isolation:** only that target is ever streamed. Research how to keep the target unthrottled while visible, and how `Page.startScreencast` behaves for background windows.
- **End:** resuming the task (the user said "done") revokes the token and stops the screencast. An `open` handoff past its deadline expires, and the agent can issue a fresh link on request.
- **While a handoff is active, the agent must not act on that window.** Coordinate with the domain lock: the handoff holds it.

Tests: token lifecycle (single use, deadline, revocation), the gateway relay with a fake page and fake VM, and input frames mapped to CDP calls.

## As built

- `handoffs` table and `@winston/db/handoffs` (create, single-use connect with a reconnect secret, 15-min deadline, resolve on resume/cancel/finish, front-of-house resolution on the user's next message, latest for fresh links).
- Background park holds the run's window (`browser.hold` via the gateway's internal API) and puts the link in `task.needs_user`; the front of house's handoff sends its link to the user directly. `winston task link <id>` for a fresh one.
- Gateway: `/handoff/connect` page socket (auth by first message, close codes), relay of binary frames and validated input for that handoff only, hold/release, release on resume/cancel (vm-api hook).
- winstond: hold/release in the registry (acting refused, locks pinned, no idle sweep), `screencast.ts` (own CDP session, focus emulation, first-frame screenshot, acked JPEG screencast, input replay), `handoff-frames.ts`, daemon routing and binary sends.
- Tests: db token lifecycle, gateway relay with a fake page and fake VM (frames, input, single use, reconnect, release, expiry), winstond screencast and input mapping, registry hold, agents' handoff tools. Checked against real Chrome in the local VM (background window streams, input replays).

