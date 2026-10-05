---
id: "33cdec"
title: Typing into a taken-over browser is clunky
status: backlog
priority: none
labels:
  - browser
  - collab
  - spec
  - web
created_at: 2026-10-05T21:33:27.614Z
updated_at: 2026-10-05T21:33:27.614Z
---

**Needs a spec with the founder before any building**, and testing on their phone together, as with the live-view page (ff4636). Raised by the founder on 2026-10-06: they don't like the Keyboard UX when taking over a browser.

## Today

With a window in hand, `/browser` shows a **Keyboard** button that focuses an invisible field (`apps/web/src/routes/browser.tsx`). What's typed there is diffed and sent to the tab as text and keys, which `winstond` replays with CDP (`Input.insertText`, `Input.dispatchKeyEvent`). The problems:

- **Typing is blind.** The field is invisible, and you only see your text once the next frame arrives, 100–300 ms later.
- **Each field needs Keyboard again.** A tap on the view closes the phone's keyboard. On a computer the keys just stopped arriving; 30a1fa fixes that one case.
- **The phone can't help.** The field is a plain text field with autocomplete off, so the person's password manager offers nothing, and neither do iOS's and Android's suggestions for codes that arrived by text or email. A password or a 2FA code is the most common reason for a handoff.
- **Shortcuts don't reach the tab.** Only named keys (Enter, Tab, arrows…) go through, so Ctrl/Cmd shortcuts act on the hidden field, not the page.

## Proposal: type where you tap

- **`winstond` reports the tab's focus** to the page: when an editable gets focus, its kind (text, email, number, password, one-time code) and label, and when focus leaves. It never sends what's in a password field. One way: a listener in our isolated world, as for the fast page read, reporting through a binding. It has to cover frames too, cross-site ones included.
- **The page shows a visible field** at the bottom while one is focused, labeled with the tab's field and site ("Password · github.com"), of the matching type: `type=password` with show/hide, so the person's password manager can fill it; `inputmode=numeric` + `autocomplete=one-time-code` for codes, so the phone suggests one that just arrived; `type=email` for email. Typing still goes through live, as now.
- **On a phone:** iOS opens the keyboard only from a direct tap on a field, and the page learns the tab's focus a round trip after the tap. So the first field takes one tap on the visible field. After that the keyboard stays up while the person taps between fields in the view, and the visible field follows. To verify on a real iPhone and Android phone.
- **On a computer:** typing goes straight to the tab after a click, like a normal browser (30a1fa started this). Forward Ctrl/Cmd shortcuts too.
- **The Keyboard button goes away.** A small keyboard icon stays as a fallback for what detection can't see (canvas-drawn editors, closed shadow roots, the full-desktop view).

## Questions for the spec

- Live typing, or compose in the field and send on Enter? Live is how it works today and suits sites that react as you type; composing makes autofill and fixing typos simpler.
- Does the visible field start empty, or with the tab field's current text (not for passwords)?
- What counts as a one-time-code field when the site doesn't say so (`maxlength`, `inputmode`, names like code, otp)? And how do split code boxes behave, where each box takes one digit?
- How do the phone's own password manager and Winston's Chrome interact? Filling the person's own password into Winston's browser is the point of a handoff, but it mustn't end up saved on the VM (docs/design.md Invariant 1).

**Done when**

- [ ] A spec agreed with the founder, written into this ticket and docs/design.md.
- [ ] Building tickets filed under this one.
