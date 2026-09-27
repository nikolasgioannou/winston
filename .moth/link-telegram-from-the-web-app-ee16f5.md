---
id: "ee16f5"
title: Link Telegram from the web app
status: todo
priority: none
labels:
  - m3
  - telegram
  - web
created_at: 2026-09-27T05:34:40.796Z
updated_at: 2026-09-27T05:34:40.863Z
blocked_by:
  - "bb2d67"
  - "e47a50"
  - "ea7ecd"
---

The Google-first onboarding flow (product.md §1, Onboarding flow). The user taps **Connect Telegram** and Telegram opens at `t.me/<bot>?start=<one-time-token>`. The bot receives `/start <token>` and links the chat. This replaces the M1 seed for linking.

Build:
- A server function that creates a link token (stores the hash, 15-minute expiry) and returns the deep link. The bot username comes from config: `RunWinstonDevBot` locally, `RunWinstonBot` in production.
- The `/telegram` page: status (linked as @username, or not linked), a **Connect** button, and a **QR code** for users on desktop. Research a small QR library that renders client-side. Relinking replaces the old link.
- Also surface the same connect action in `/home`'s checklist.
- In `api`'s Telegram handler: `/start <token>` validates the token (unused, unexpired), links `chat_id` to the user (moving it if that chat was linked elsewhere), marks the token used, and produces the always-delivered `system.onboarding.completed` item, so Winston sends his brief hello through a normal front-of-house turn. A `/start` with a bad or expired token gets a helpful reply pointing back to the site.
- The web page updates to "linked" without a manual refresh (poll while the page is open).

Add the page's states to the dev design view.

Tests: token single-use and expiry, relinking behaviour, a chat already linked to another user, and that the onboarding item triggers a turn.
