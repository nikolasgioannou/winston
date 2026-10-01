---
id: "4bd5a3"
title: Divide dialog headers and give the account dialog tabs
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T01:29:46.941Z
updated_at: 2026-10-01T01:34:48.550Z
blocked_by:
  - "8fffdd"
---

The founder's feedback on the dialogs:

- `Dialog`'s header (title and subtitle) gets a hairline divider underneath that runs the full width of the dialog, edge to edge.
- The account dialog splits into tabs: **Permissions** (the capability switches) and **Connection** (reconnect, disconnect and the like). The tabs sit at the bottom of the header, above the divider. Build the tabs into the design system (Base UI's Tabs), so any dialog can use them.
- Update the dev design view and design.md.

## Outcome

- `Dialog`'s header (title, subtitle, close) has a hairline divider under it, edge to edge. With the new `tabs` prop (Base UI's Tabs), the tab list sits at the bottom of the header with a sliding indicator on the divider, and each tab's content fills the scrolling body; `children` show above every tab.
- The dialog now hangs a fixed distance below the top (at most 96px) instead of being centred, so switching to a shorter tab moves only its bottom edge rather than making it jump.
- The account dialog has **Permissions** (the capability switches) and **Connection** (Reconnect, Disconnect) tabs, each a card, with the status callout above both.
- Dev design view: a "Connection tab" state, and the disconnect confirmation opens on that tab. Checked both tabs and the indicator.

