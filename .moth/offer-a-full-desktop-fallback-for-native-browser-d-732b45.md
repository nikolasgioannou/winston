---
id: "732b45"
title: Offer a full-desktop fallback for native browser dialogs
status: done
priority: none
labels:
  - browser
  - m8
  - vm
created_at: 2026-09-27T05:42:04.047Z
updated_at: 2026-10-02T16:28:18.574Z
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

## As built

- **No noVNC server on the VM:** `x11vnc` serves display `:99` on `127.0.0.1:5900` (`vnc.service` in `image/scripts/chrome.sh`), and the noVNC *client* (`@novnc/novnc` 1.7, with a local type shim for its new root export) runs in the page. `winstond` tunnels the raw RFB bytes, so no websockify is needed.
- **Frames:** `desktop.open` / `desktop.close` (gateway → VM), `desktop.closed` (VM → gateway), and binary `desktopMessage`s (`{"desktop":<handoffId>}`, newline, bytes) both ways.
- **Access:** the page's second socket to `/handoff/connect` signs in with its session secret and `desktop: true`, so it opens only after the link was used and while the handoff is `connected`; it closes with the live view, the task carrying on and the VM's connection. Reusing `/handoff/connect` kept the ALB rules as they were.
- **On the page:** a small header button (monitor icon) switches to the full desktop and back; the screen is shown at full size and dragged to pan; the Keyboard field types as X keysyms. Checked locally at phone size: a native `<select>` popup showed and an option was picked.
- Tests: framing round-trip, the gateway refusing a desktop without a connected handoff and relaying bytes intact, `winstond`'s tunnel against a fake VNC server, keysyms.
