---
id: "30a1fa"
title: Typing stops after clicking in the browser page on a computer
status: done
priority: medium
labels:
  - browser
  - web
created_at: 2026-10-05T21:33:12.725Z
updated_at: 2026-10-05T22:13:11.001Z
---

On `/browser`, with a window in hand, typing goes through a hidden field that the **Keyboard** button focuses (`apps/web/src/routes/browser.tsx`). A click on the live view takes the focus off that field, because the canvas can't hold focus: the browser moves it to the page's body. On a computer nothing shows that happened, so the keys just stop reaching the tab.

The founder hit it as "typing doesn't work in password fields": on a login form you press Keyboard, type the username, click the password field, and from then on nothing types. Checked on 2026-10-06 that the VM side is fine: `Input.insertText` and key events reach a password field in the VM image's Chrome, on a plain page and inside a cross-site frame.

This is the small fix for computers. Phones keep today's behaviour (a tap on the view closes the keyboard) until the input redesign is specified with the founder.

**What to build**

- A mouse click on the live view keeps the typing field focused, or focuses it if it wasn't, so on a computer you click a field in the tab and type, as in any browser.
- Each click starts the field afresh, so text typed for one field in the tab never turns into backspaces in the next.
- Touch is left as it is.

**Done when**

- [ ] On a computer, with control: click a field in the tab, type, click another field, type, and both get their text without pressing Keyboard.
- [ ] On a phone (or touch emulation), a tap on the view still doesn't bring up the keyboard by itself.
- [x] docs/design.md describes how typing reaches the tab on a computer.


## As built

The canvas's `pointerup` focuses the typing field again after a mouse click (`apps/web/src/routes/browser.tsx`). The click still takes the focus first, so the field's existing blur handler empties it: each click starts afresh with no new code for that. A touch `pointerup` doesn't refocus, so phones behave as before.

Checked in a browser with a page built the same way (canvas, hidden field, Keyboard button): before the fix a click on the canvas left the focus on the page's body. After it, with no Keyboard press, "click, type a username, click, type a password" sent both, the second without backspaces. Not yet tried in the running app, because another checkout's dev stack was running.


Closed at the founder's request to land it before an in-app check (2026-10-06). The two unticked boxes are still to be confirmed in the running app after the next deploy. Phones should behave as before: their touch path is unchanged.
