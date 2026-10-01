---
id: "465392"
title: Add a not-found page
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-30T22:21:08.320Z
updated_at: 2026-10-01T00:39:26.462Z
blocked_by:
  - "5e3c6d"
---

A page that doesn't exist shows TanStack Router's bare `<p>Not Found</p>`, and the dev server warns on every one that no `notFoundComponent` is configured. Add a not-found page in the design system's style (a short message and a way home: `/home` when signed in, `/` otherwise) as the router's default, and use it for loaders that throw `notFound()` too (like an account that isn't the user's). Add it to the dev design view.

Done autonomously with the rest of this batch; the founder reviews it all at the end.

## Outcome

- `NotFoundPage`: a centred `EmptyState` ("Page not found", "There's nothing at this address.") with **Go to Winston**, linking to `/` (home when signed in, sign-in otherwise), on the page background since it can show signed in or out.
- Registered as the router's `defaultNotFoundComponent`, so unknown addresses (served with a 404) and loaders that throw `notFound()` use it, and the dev server's warnings stop.
- Dev design view: "Not found". Checked `/nowhere` returns 404 with the page.

