---
id: "b8e28a"
title: Show the browser live on a signed-in page, with control in place
status: done
priority: none
labels:
  - browser
  - telegram
  - web
created_at: 2026-10-03T17:26:02.845Z
updated_at: 2026-10-03T20:15:29.804Z
---

The founder (2026-10-03): "Why does it even need to end the browser view? If I'm signed in, why don't we just put it behind a signed-in route, and then I can view the browser even while it's live and doing stuff… and if it hands off, then I can just, in the same link, look at that and edit it myself."

## What's wrong today

The live view is a per-handoff page (`/t/<token>`, ff4636, f0507c).
- **How a link works:** a random token, single use, a 15-minute connect deadline, bound to one tab, with a viewer secret for reconnects.
- **When the view exists:** only once Winston has handed over, and only for that one tab.
- **It ends the moment the founder writes anything.** That's by design: a front-of-house turn resolves its handoffs when the user writes (`apps/agents/src/front/turn.ts`, `resolveFrontHandoffs`). In the trace, the founder's "It's just showing empty screen" killed the link, then "Link is dead need a new one". People naturally talk while they're in the live view.
- **No watching:** there's no way to see what Winston is doing before or between handoffs, though the founder wants to watch, and that's often how they'd notice a wrong turn early.

## Proposal: one signed-in browser page

1. **`/browser`, signed in, mobile-first.**
   - **What it shows:** Winston's open windows (the front of house's and each task's), each with its owner, title and site. The selected window plays live (default: the one handed over, else the most recently active).
   - **While Winston drives:** it's watch-only, with a clear "Winston is browsing" state, and input is ignored.
   - **When Winston hands over:** the window shows "Your turn: <reason>", and the existing controls turn on: tap, scroll, keyboard, Done, and the full-desktop button (732b45).
2. **Take over any time.** A "Take over" button holds the window for the user without a handoff, using the existing hold (`browser.hold`): Winston's commands in it are refused with "the user took over this window". Done, or "Give back", returns it. The founder asked to be able to "edit it myself"; this is that, beyond handoffs.
3. **Handoffs keep their meaning; the view stops having a lifetime.** A handoff still parks a task, or ends the front's turn, and still resumes on Done or "done" in chat. But chat messages no longer end anything on the page: the user keeps watching after control returns to Winston. Only Done, a "done"/resume, or the task ending (cancel or finish) gives control back.
4. **The Telegram link points at the page:** `https://runwinston.com/browser?window=win_…`, not a single-use token. *Sign-in from a phone is the hard part; see "Signing in from Telegram" below.*
5. **Gateway authentication.**
   - **The problem:** the site's session cookie is `__Host-winston_session`, bound to `runwinston.com` only, so it never reaches `gateway.runwinston.com`.
   - **The fix:** the signed-in page asks its own server for a short-lived viewer token (signed, user id, about 60 s expiry, with a new secret shared by `web` and `gateway`), and sends it as the socket's first message, as today's token is. The gateway checks it and that the user owns the VM.
   - **Reconnects:** a dropped socket gets a fresh token from the page's session, so the viewer-secret machinery goes.
6. **Several viewers.** Phone and laptop can both watch; control belongs to one viewer at a time (the last to take it).
7. **Streaming only while watched:** the screencast runs for a window only while a page shows it (as today), and stops when the page goes away.

## Signing in from Telegram (researched 2026-10-03)

Today's token links need no sign-in, so they work in any browser. A signed-in page doesn't, and Telegram makes that hard. These facts come from the open-source clients (Android 12.10.6; iOS source from July 2026) and the docs, not a device test:

- **Telegram opens links in its own browser by default,** on both platforms since mid-2024: a `WKWebView` on iOS, an Android `WebView` on Android. Users can switch to Safari/Chrome, or set "Always open this site in browser" per site; the choice is saved to their Telegram account. A bot can't force the external browser.
- **That browser has its own cookies,** not Safari's or Chrome's. So a link from Winston usually opens signed out, even when the founder is signed in in Safari. Once signed in there, our 30-day cookie keeps them signed in, as a second session.
- **Google sign-in can't be relied on there.** Google's OAuth policy forbids embedded webviews (the `disallowed_useragent` rule). Telegram's user-agent disguise may get past it, but even then there's no Google session and no passkeys, only password plus 2FA.
- **This also affects the Google connect and reconnect links Winston already sends** (75846c). The consent screen is Google sign-in, so it needs a real browser. Check it on the founder's phone.

**Recommendation:**
- **Links to signed-in pages are `login_url` buttons,** not plain links. This is a Telegram inline button (Bot API 10.3 also allows it on rich-message buttons). When tapped, Telegram appends the tapping user's `id`, `auth_date` and a `hash` signed with a key derived from the bot token.
  - **It points at `/auth/telegram?next=/browser?window=…`.**
  - **The handler:**
    - verifies the hash, and accepts `auth_date` only within about 2 minutes;
    - accepts each hash once (Telegram adds no nonce);
    - maps the Telegram user through `telegram_links.telegram_user_id`, refusing anyone not linked, so a forwarded button logs no one in as the founder;
    - creates or reuses a `web_sessions` row and cookie;
    - redirects (303) to `next` after checking it with the existing `returnPath` helper, with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
  - **No stored tokens, and old messages keep working.**
  - **Needs the site's domain linked to the bot in BotFather (`/setdomain`),** which is a founder step.
  - **Sending it** means the handoff and `task.needs_user` messages carry a button instead of the link in text (`apps/agents/src/tools/handoff.ts` `handoffLinkMessage`, `deliverReply`).
- **Optional fallback:** "Log in with Telegram" (Telegram's OpenID Connect login, April 2026) on the sign-in page, for plain links, desktop and expired sessions. It works where Google doesn't. It can be its own ticket if wanted.
- **Google flows stay in a real browser.** The sign-in and connect pages say "open this in Safari/Chrome" when they can tell they're inside Telegram (Android sends `X-Requested-With: org.telegram.messenger`; iOS can't be detected). The founder can set "Always open runwinston.com in browser" once.
- **Check on a real iPhone and Android phone before building:**
  - how often Telegram's "Log in to runwinston.com?" prompt appears;
  - how Google sign-in behaves in Telegram's browser;
  - whether the session cookie sticks.

## What goes away

`/t/<token>`. Old links should redirect to `/browser` after sign-in. Also: token hashing and the connect deadline, the viewer secret, `handoffs.token_hash` and `viewer_secret_hash` (the `handoffs` row stays as the record of who has control, why, and when it ended), and the `task.needs_user` `<link>` (it becomes the page link). §13's "bound to one CDP target… revoked on resume" is rewritten: viewing is owner-only and session-bound; control is per window.

## Relation to other tickets

- **Window lifecycle (dfe034):** finished runs' windows close, a task can take over the front's window, and a blank window is never handed over. The page lists whatever exists, so those fixes matter here.
- **jev-ultrafast (6abd9d):** autopilot runs become watchable live, which is the point.

Docs: §5 (Browser handoff), §13 (Security), §20 (pages: `/browser` replaces `/t/<token>`), decision #7, product.md (Browser use).

Tests:
- **The page:** lists only the owner's windows and plays the selected one; watch-only input is ignored; a handoff turns on control and Done gives it back; "Take over" refuses Winston's commands in that window until given back; a chat message during a handoff doesn't end the view.
- **Gateway tokens:** a viewer token for another user or an expired one is refused.
- **Old links:** `/t/` links redirect.
- **Telegram sign-in:** a valid `login_url` signature signs in the linked user and lands on `next`; a stale `auth_date`, a reused hash, a bad signature, an unlinked Telegram user or an off-site `next` are each refused.

## As built

- **`/browser`** (signed in; signed-out visits go through sign-in and come back via `returnPath`):
  - **Windows:** every window is listed with what it's for (the conversation, or the task's brief) and its site. The chosen one plays live: the `?window=` one, else one waiting on the person, else the latest.
  - **Watching and control:** watch-only while Winston drives; "Your turn: <reason>" with Keyboard, Done and the full desktop when it's handed over. Take over works on any window; Give back returns a taken-over one.
  - **Many viewers:** several pages can watch; control is the last taker's.
  - **Chat ends nothing on the page.**
  - **Also:** in the sidebar; old `/t/<token>` links redirect here; the dev design view has its states.
- **Gateway auth by viewer ticket, not a signed token:**
  - **What a ticket is:** `viewer_tickets` rows, hashed, with a minute's life, used once, issued by the page's server function.
  - **Why not a signed token:** the two services already share the database, so no new shared secret or infrastructure was needed. A reconnect gets a fresh ticket.
- **The live-view protocol:**
  - **Requests:** `windows` (winstond answers `browser.list`; the gateway adds purposes and reasons from the database), `watch`, `control` and `done`. Anything else the page sends is input, passed on only from the page with control.
  - **Ids:** live views are keyed by a per-page `viewId`, renamed from `handoffId` in the frames.
  - **Automatic control:** a window the person has, with nobody in control, goes to the first page that watches it.
  - **Taking over:** `browser.hold` with `windowId` and `takeover`. winstond refuses Winston's commands in that window with its own message.
  - **Giving back:** `done` resumes a handoff as before, or releases a taken-over window (`browser.release` with `windowId`).
  - **Size:** when control goes, that page's stream restarts in a new session, so the phone-sized emulation never lingers for Winston.
- **The front of house** gives back only the windows it handed over when the user writes (`resolveFrontHandoffs` now returns their windows). Pages keep watching.
- **Telegram:** any message carrying a `/browser` link gets a `login_url` button ("Open the browser"), resent without it if Telegram refuses (until `/setdomain`). `/auth/telegram`:
  - checks the signature with **`TELEGRAM_LOGIN_KEY` (SHA-256 of the bot token)** rather than the token, so the site never holds the token; the existing secrets test that keeps the bot token from the site still holds, and `prod:keys` derives the key;
  - accepts a login only within 2 minutes;
  - uses each hash once (`telegram_logins`);
  - signs in only the linked Telegram user;
  - creates the session and redirects 303 to `next`. Anything else goes to the usual sign-in.
- **Gone:** handoff tokens, connect deadlines, viewer secrets, `handoffs.token_hash`, `viewer_secret_hash` and `connect_deadline` (migration; `connected` rows become `open`), `connectHandoff`/`reconnectHandoff`/`handoffLink`, and the old page. `winston task link` now prints the page link.
- **Founder steps:**
  1. In BotFather, `/setdomain` for @RunWinstonBot → runwinston.com.
  2. `bun run prod:keys` (blank answers keep values; it derives the sign-in key).
  3. Check on a phone: Telegram's login prompt, Google sign-in in Telegram's browser, and whether the session sticks.
  4. Then try a handoff and a take-over.

Tests:
- **gateway:** ticket sign-in once, listing with purposes and reasons, one page's frames, watch-only until take-over, handed-over control and Done resuming the task with the page still open, two pages handing control over, a Winston-side release keeping views open, the desktop gated on control, a window ending its stream, 4001 on VM disconnect.
- **winstond:** take-over refusal, per-window release, the list.
- **db:** links, tickets, login claims.
- **web:** the Telegram signature (valid, tampered, wrong bot, stale, missing) and the return path.
- **agents:** the sign-in button and its fallback.
