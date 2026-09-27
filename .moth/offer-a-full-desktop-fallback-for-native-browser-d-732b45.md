---
id: "732b45"
title: Offer a full-desktop fallback for native browser dialogs
status: todo
priority: none
labels:
  - browser
  - m8
  - vm
created_at: 2026-09-27T05:42:04.047Z
updated_at: 2026-09-27T05:42:04.083Z
blocked_by:
  - "f0507c"
---

The per-tab screencast can't show browser-level UI: native `<select>` popups, file pickers, some permission prompts and basic-auth dialogs. For those cases, the handoff page offers a hidden **"open full desktop"** fallback through noVNC (docs/design.md §5 Browser).

Build:
- noVNC and a VNC server attached to the Xvfb display in the image, as systemd units bound to **localhost only**.
- A proxy path through `gateway` → `winstond`, reusing the websocket (research tunnelling the VNC websocket bytes as frames). It's available **only while the handoff token is connected**, never otherwise.
- The link on the handoff page opens the noVNC client pointed at that proxy.

There's no inbound access to the VM at any point, which keeps the security properties from §15.

Tests: the proxy refusing access without a live handoff, and bytes relayed intact (with fake endpoints). Manually, check that a native `<select>` can be operated on a phone through the fallback.
