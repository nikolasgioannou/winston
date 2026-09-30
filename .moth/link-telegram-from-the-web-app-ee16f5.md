---
id: "ee16f5"
title: Link Telegram from the web app
status: done
priority: none
labels:
  - m3
  - telegram
  - web
created_at: 2026-09-27T05:34:40.796Z
updated_at: 2026-09-30T03:27:15.632Z
blocked_by:
  - "bb2d67"
  - "e47a50"
  - "ea7ecd"
---

The Google-first onboarding flow (product.md §1, Onboarding flow). The user taps **Connect Telegram** and Telegram opens at `t.me/<bot>?start=<one-time-token>`. The bot receives `/start <token>` and links the chat. This replaces the M1 seed for linking.

Build:
- A server function that creates a link token (stores the hash, 15-minute expiry) and returns the deep link. The bot username comes from config: `RunWinstonDevBot` locally, `RunWinstonBot` in production.
- A **Telegram** section on `/profile` (not its own page; the founder's call): status (linked as @username, or not linked), a **Connect** button, and a **QR code** for users on desktop. Research a small QR library that renders client-side. Relinking replaces the old link.
- Also surface the same connect action in `/home`'s checklist.
- In `api`'s Telegram handler: `/start <token>` validates the token (unused, unexpired), links `chat_id` to the user (moving it if that chat was linked elsewhere), marks the token used, and produces the always-delivered `system.onboarding.completed` item, so Winston sends his brief hello through a normal front-of-house turn. A `/start` with a bad or expired token gets a helpful reply pointing back to the site.
- The web page updates to "linked" without a manual refresh (poll while the page is open).

Add the page's states to the dev design view.

Tests: token single-use and expiry, relinking behaviour, a chat already linked to another user, and that the onboarding item triggers a turn.

## Outcome

- Site: a `createTelegramLink` server function issues a link token and returns `https://t.me/<TELEGRAM_BOT_USERNAME>?start=<token>` (new web config, `RunWinstonDevBot` by default) with its expiry. `useTelegramLink` asks for one while connecting and replaces it a minute before it expires; `useReloadWhile` re-runs the page's loaders every 3 s while waiting (it now also drives `/home`'s computer polling).
- QR: lean-qr 2.7.4 (actively maintained, no dependencies, about 69 KB unpacked), used through its `generate` and `toSvgPath` in a new `QrCode` component in `packages/ui`: one SVG path with a 4-module quiet zone, black on white even in dark mode. Shown from 640px up; phones get the button.
- `/profile` has its first real page (`src/pages/profile-page.tsx`): a Telegram section (Connect + QR; "Linked as @username" with **Link another account**, which lasts until the link changes or it's cancelled) and an Account section with Sign out. `/home`'s checklist has the same Connect button and QR.
- Bot: `/start <token>` consumes the token and links the chat in one transaction, moving it from another user and replacing the user's old chat. A newly linked chat gets a `system.onboarding.completed` item (new `onboardingCompletedType` in `@winston/domain/inbound`) and a debounced front-of-house turn; relinking the same chat replies "You're already connected. Just message me." A bad, used or expired token gets a reply pointing back to the site. The front-of-house prompt says what the event means: a brief hello, no questionnaire.
- `SEED_TELEGRAM_CHAT_ID` stays as a shortcut after database resets; docs/local-dev.md now links through the site.
- Dev design view: Home's states show the QR; Profile has not linked, link loading, linked, linked without a username, and linking another account. The relink buttons moved under the row after a mobile check.
- Tests: linking and the hello's turn, single use, expired/unknown/malformed tokens, moving a chat from another user, relinking the same chat, a plain `/start`, the deep link's shape and token, and the linked username. Token expiry and races were already covered in `@winston/db`.
- Checked live against `bun dev` with a throwaway user: the profile page issued a real link and QR, a `/start` update posted to the local api linked the chat and stored the onboarding item, and the page switched to "Linked as @linky_test" on its own. The hello turn was dropped since the chat was fake, and the user was deleted afterwards.

