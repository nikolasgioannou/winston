---
id: "0bfa49"
title: Ramp accounts don't appear on the site
status: in-progress
priority: none
labels:
  - ui
  - web
parent: "80fcf0"
created_at: 2026-10-05T23:01:23.100Z
updated_at: 2026-10-17T17:56:28.566Z
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

- [x] `/dev/design` shows Ramp on Connected accounts, the account dialog and Home, in light and dark, at desktop and mobile width
- [ ] Toggling a Ramp capability on the site changes what `winston accounts get` shows
- [x] `product.md` §1 (The website) mentions Ramp


## As built (the toggle check waits on the founder's local test)

- **Icon:** Ramp's row and dialog use a plain receipt icon (lucide `Receipt`), not Ramp's mark. Ramp publishes no brand kit, and Simple Icons and thesvg have no copy. Swap in the real mark if the founder wants it, as was decided for Google's icons.
- **Add account:** offers Ramp under "Spend" (the domain's badge), linking `connectPath("ramp")`.
- **Copy:** disconnecting a Ramp account says Ramp keeps listing "Ramp MCP Remote", rather than "revoked with Google". The empty state and Home name Ramp beside Gmail and Calendar. A Ramp refusal (`ramp_refused`) tells the user to ask a Ramp admin to allow them Ramp MCP.
- **Fixtures:**
  - `companyRamp` appears in "A few accounts", in a new "Disconnect Ramp" state and in the dialog's "Ramp, write scopes not granted" state.
  - Checked in the design view on a spare port (3990), desktop width: the row, the Add account dialog (Mail, Calendar, Spend) and the dialog's copy, including "Not granted on Ramp's screen".
  - Not shown: Home doesn't list accounts by provider, so it has no Ramp state.
- **Not yet checked:** a live toggle changing `winston accounts get`. The toggles are the same generic code as mail and calendar.


**Ramp's mark (2026-10-17, the founder's ask):** `RampIcon` in `@winston/ui/brand-icons` replaces the receipt. It's the two strokes from the logo Ramp serves (`next.ramp.com/assets/images/ramp-logo.svg`), unmodified, drawn in the text color. Ramp has no brand kit; as with Google's icons, it's used on a private, friends-only site, and Ramp should be asked before any wider launch. Also fixed the Ramp fixture's address (`ada@acme.com`).


**Yellow (2026-10-17, the founder's ask):** `RampIcon` is now Ramp's app icon, the black mark on Ramp's yellow (#E4F222) circle, as Ramp's own touch icon shows it.
