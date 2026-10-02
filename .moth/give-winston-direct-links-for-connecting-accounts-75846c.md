---
id: "75846c"
title: Give Winston direct links for connecting accounts
status: backlog
priority: none
labels:
  - m7
  - prompts
created_at: 2026-10-01T23:53:50.394Z
updated_at: 2026-10-01T23:53:55.733Z
blocked_by:
  - "fa537d"
---

Found in go-live (2026-10-01): asked by voice for a link to connect Google, Winston had none, invented "Settings → Accounts" (the page is `/accounts`), and said "I can't browse the web to fetch the exact URL". After connecting Gmail he said "Calendar usually comes with it; I'll let you know if it doesn't show up", which is wrong twice: mail and calendar are separate connections, and he promised a follow-up with no trigger behind it.

- **Direct connect links:** `winston accounts connect <mail|calendar>` prints the link that starts connecting straight away (`<site>/auth/google/connect?domain=mail|calendar`, which already exists; the site's public URL comes from the backend, like reconnect links, so it's always right). If the user isn't signed in, the link should land them back in the connect flow after sign-in, not on the home page (check and fix).
- **Prompt (front of house, and background where it applies):**
  - When the user wants to connect something, run the command and send the link. Don't describe site navigation; name only pages that exist (`/accounts`), never guess.
  - Mail and calendar are **separate connections**, even for the same Google account: connecting one doesn't connect the other. When one is connected, offer the other's link if it would help.
  - `system.app.connected` acknowledgement: say what was connected (its domain), no claims about the rest.
- Reconnect links already exist (`reconnectUrl` on auth_expiring/expired); keep them as they are.

- **Failures, no empty promises:** when a command fails (seen 2026-10-01: the gateway's stale Google client made every calendar call fail), Winston said three times "I'll check again in a bit and let you know" with no trigger behind it, and called it a service hiccup. The prompt should make him say plainly that it failed and that he'll look when asked, or set an actual `--at` trigger to retry, never promise without one. Add this to the eval.

Tests: the command prints the right link per domain and refuses others; the sign-in redirect keeps the connect intent. Spot-check the prompt with a short eval: "send me a link to connect my calendar", and a `system.app.connected` for mail.
