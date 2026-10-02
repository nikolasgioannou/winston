---
id: "ff4636"
title: Build the handoff live-view page and test it on phones (with the founder)
status: in-progress
priority: none
labels:
  - browser
  - collab
  - m8
  - web
created_at: 2026-09-27T05:42:03.975Z
updated_at: 2026-10-02T04:57:24.037Z
blocked_by:
  - "7b6af9"
  - "f0507c"
---

`/t/<token>` is the page the user opens from Telegram, almost always **on their phone**, to unblock Winston (docs/design.md §5 Browser, §20). It has no sidebar and needs no sign-in, since the token is the credential. It must work well on mobile.

Build with `packages/ui`:
- A canvas drawing the screencast frames, scaled to fit the phone while keeping coordinates accurate.
- **Touch → mouse mapping:** tap to click, drag to scroll, and long-press for right-click if needed. Map canvas coordinates back to page coordinates correctly across device pixel ratios.
- **Keyboard:** a real hidden `<input>` that summons the phone's keyboard and forwards keystrokes (including backspace, enter and paste), because typing a password or 2FA code is the most common reason for a handoff.
- **States:** connecting, live, reconnecting (network blips on phones are normal), expired/invalid link, and resolved ("You're done. Tell Winston in Telegram").
- A clear line telling the user to message Winston "done" when finished. Resuming happens in chat (§1).
- A small "open full desktop" link for native dialogs the screencast can't show. The next ticket builds it.

Add all states to the dev design view. **Test on real iPhone and Android devices with the founder.** This is the open question from product.md about mobile quality. Iterate on the feel together until typing a code and tapping buttons is comfortable.

## Progress (2026-10-02)

Built and checked end to end in the local VM at phone size (375×812): tap to click, the keyboard button typing a code, a submit, wheel scrolling, a reload reconnecting with the page's secret, and "All done" when the handoff ends.

- `/t/$token` (public, `no-referrer`, `noindex`): `src/handoff/input.ts` (canvas → tab coordinates, tap vs drag, mouse direct, keyboard as text diffs so composing and autocorrect work, close codes → states), `src/handoff/connection.ts` (auth by first message, session secret in sessionStorage, reconnect with backoff), `src/pages/handoff-page.tsx` (states: connecting, live, reconnecting, done, expired, invalid, elsewhere; all in the design view).
- **The tab is shown at the phone's size** while watched: the page sends its viewport and `winstond` sets `Emulation.setDeviceMetricsOverride` on the live view's own session, so the site lays out for the phone; the agent's session keeps the desktop size. Without it a 1920-wide tab shrank to nothing.
- Fixed on the way: live-view input replays in order (a tap's release was overtaking its press, so taps never clicked); the page always draws the newest frame (it could end on a stale one); the load balancer now routes `/handoff/connect` (147 left it out); the site gets `GATEWAY_PUBLIC_URL`.
- No "open full desktop" link yet: 732b45 builds the desktop, and a link to nothing would be speculative.

**Left, with the founder:** try it on a real iPhone (and Android if available) in production, and iterate on the feel.

**Founder feedback (2026-10-02):** it worked well in production on their phone; handing back should be on the page rather than a trip to Telegram. Added a **Done** button: the gateway resumes a parked task, or records `system.handoff.done` for the front of house, then releases the window. Decision #7 updated.

