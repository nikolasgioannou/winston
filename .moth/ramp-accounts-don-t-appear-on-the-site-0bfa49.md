---
id: "0bfa49"
title: Ramp accounts don't appear on the site
status: todo
priority: none
labels:
  - ui
  - web
parent: "80fcf0"
created_at: 2026-10-05T23:01:23.100Z
updated_at: 2026-10-05T23:01:42.080Z
blocked_by:
  - "8f6c44"
---

Once Ramp can be connected (8f6c44), the site has to show it like Gmail and Calendar.

**What to build**

- A Ramp entry in `connectableProviders`, so the add-account dialog offers it, with a Ramp brand icon in `@winston/ui/brand-icons` (check Ramp's brand guidelines and note the licence, as the others do).
- Connected accounts lists Ramp connections with the business name, status and reconnect.
- Each capability toggle explains itself in Ramp's terms (`read`: "See transactions, reimbursements and what's waiting on you"; `approve`: "Approve and reject transactions, reimbursements and requests"; and so on), and an unavailable capability says Ramp didn't grant it.
- Home's checklist count and wording ("your Gmail and Google Calendar") include Ramp.
- Error copy for a failed Ramp connect, including the case where the user's company hasn't enabled Ramp MCP for them, which tells them to ask their Ramp admin.
- The dev design view fixtures cover a Ramp account in every state.

**Done when**

- [ ] `/dev/design` shows Ramp on Connected accounts, the account dialog and Home, in light and dark, at desktop and mobile width
- [ ] Toggling a Ramp capability on the site changes what `winston accounts get` shows
- [ ] `product.md` §1 (The website) mentions Ramp
