# Research: browser infrastructure, live view & VM hosting

> Researched 2026-09-26. Figures come from providers' docs and some third-party pages. Check prices before committing.

## Summary recommendation
**Build our own:** one persistent VM per user running headed Chrome (one profile, one browser process, many tabs), with a **per-tab CDP screencast live view** behind our own signed, expiring links. Keep a thin "browser backend" interface so we can route anti-bot-heavy sites to a hosted provider (Kernel or Browserbase) later.

## Why not a hosted browser provider as the default
- All of them bill and limit by **session**. Logins persist by saving and reloading profiles, not by keeping one browser up.
- Most discourage **concurrent sessions on one profile**. Browserbase warns that sites may force a logout; Kernel allows one writer. Our model is "several agents in parallel on one logged-in identity", which means one long session with many tabs, and that hits session caps (Steel: 15 min–1 h; Cloudflare: 10 min keep-alive).
- Always-on hosted browsers cost about $0.05–0.48/h, so $36–350/mo per user. A VM costs $5–25/mo.
- Only Browserbase and Cloudflare offer true per-tab takeover links. None documents a mobile-first takeover experience.

| Provider | Persistent logins | Live view | Notes |
|---|---|---|---|
| Browserbase | Contexts (warns against concurrent use) | Per-tab live URLs, iframe, read/write | $20–99/mo + hourly. Advanced stealth only on Scale |
| Kernel | Profiles (one writer) | Whole-browser WebRTC (neko-based) | Standby after 5 s idle at no usage cost. Proxies included. Open-source image |
| Steel | Profiles | Session viewer iframe | Session caps of 15 min / 1 h. Open source |
| Hyperbrowser | Profiles | `liveUrl` with expiring token | Top of a stealth benchmark (81%) |
| Browserless | Persist sessions | LiveURL, mobile emulation | Each reconnect is billed as a new unit |
| Cloudflare Browser Run | Not documented | Best link model: tab/full modes, signed JWT, connect deadline | 10-min keep-alive, so it doesn't fit |

## Live view options (self-hosted)
- **A. Xvfb + noVNC:** simple and shows native dialogs, but it's the whole screen (not one tab), laggy on mobile, and has focus-stealing problems.
- **B. CDP `Page.startScreencast` + input forwarding (recommended):** scoped to one tab by construction, and we control the mobile UI (touch mapping, a real `<input>` for the phone keyboard). Latency is about 100–300 ms.
  - Gap: native browser widgets (`<select>` popups, autofill, `window.open`) aren't captured. Work around it with keyboard input or client-side rendering.
  - Gap: background tabs get throttled. Give each agent's target its own window, or run with `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`.
  - References: agent-browser streaming, perch-browser.
- **C. WebRTC (neko, Selkies):** lowest latency, but whole desktop, needs TURN servers, more moving parts.
- **Plan:** B as the main path, with A as a hidden "open full desktop" fallback for native-dialog cases.

### Handoff link design
Map `agentId → CDP targetId`. Mint a random token (JWT, 10–15 min connect deadline, bound to that target, revoked when the agent resumes) and send `https://<winston>/t/<token>` over Telegram. That page streams only that target. The agent does not automate the target during takeover.

## VM hosting options
| Provider | Persistence / idle | Notes |
|---|---|---|
| Hetzner | Always on, no suspend | Cheapest always-on (CX33 ≈ €8.50/mo after 2026 price rises) |
| Fly.io Machines | Suspend with memory snapshot (≤2 GB RAM) | Pay rootfs + volumes while stopped. Fast resume |
| E2B | Pause kept indefinitely, ~1 s resume | Running sessions capped at 24 h (Pro $150/mo) |
| Daytona | Stop / archive | Only disk billed while stopped. Computer-use sandboxes with VNC |
| Morph Cloud | Snapshot/branch in <250 ms | MCU pricing |
| Modal | 24 h sandbox max | Poor fit |

Sizing: 2–4 vCPU / 4–8 GB is enough for Chrome with about 5 tabs.

## Sources
- Browserbase: https://docs.browserbase.com/features/session-live-view · https://docs.browserbase.com/platform/browser/core-features/contexts · https://www.browserbase.com/pricing
- Kernel: https://www.kernel.sh/docs/info/pricing · https://www.kernel.sh/docs/browsers/live-view · https://github.com/kernel/kernel-images
- Steel: https://docs.steel.dev/overview/pricinglimits · https://docs.steel.dev/overview/sessions-api/human-in-the-loop
- Hyperbrowser: https://hyperbrowser.ai/docs/sessions/live-view
- Browserless: https://www.browserless.io/blog/browserless-hybrid-automation-improvements
- Cloudflare: https://developers.cloudflare.com/browser-run/features/live-view/
- Self-host: https://github.com/m1k1o/neko · https://github.com/selkies-project/selkies · https://agent-browser.dev/streaming · https://github.com/dilkuwor/perch-browser · https://github.com/stablyai/orca/issues/15311
- VMs: https://e2b.dev/docs/sandbox/persistence · https://www.daytona.io/docs/typescript-sdk/sandbox/ · https://modal.com/docs/guide/sandbox-snapshots · https://fly.io/docs/reference/suspend-resume/ · https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
