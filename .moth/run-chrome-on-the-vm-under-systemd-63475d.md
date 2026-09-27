---
id: "63475d"
title: Run Chrome on the VM under systemd
status: todo
priority: none
labels:
  - browser
  - m8
  - vm
created_at: 2026-09-27T05:42:03.548Z
updated_at: 2026-09-27T05:42:03.603Z
blocked_by:
  - "961613"
  - "ce9145"
---

Winston's browser is a real, headful Google Chrome with **one persistent profile**, running on his VM under a virtual display (docs/design.md §5 Browser, §10 Process supervision, §18).

In the provisioning scripts, shared by the Docker and AMI builds:
- Install **Google Chrome stable** from Google's apt repository, not Chromium, so the build matches what real users run. That matters for anti-bot. Add the repository to unattended-upgrades on EC2, so Chrome security updates apply at the quiet hour.
- Install Xvfb and decent fonts (Latin, CJK, emoji), so pages render and screenshots look right.
- **systemd units:**
  - `xvfb`.
  - `chrome`, after `xvfb`, running as `winston`. Flags: the profile directory on the data volume (for example `/home/winston/.config/winston-chrome`, so logins survive instance replacement), `--remote-debugging-port` bound to **localhost only**, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, and no first-run or default-browser prompts.
  - `Restart=always`, plus a **systemd memory limit** on Chrome, so memory pressure restarts Chrome rather than the kernel killing `winstond`.
- Research the flags people use for long-running automated but "normal-looking" Chrome. Avoid flags that make the browser look automated (for example `--enable-automation`).

In `winstond`: ping Chrome over CDP every ~30 s, and restart the `chrome` unit if it's been unresponsive for 60 s.

Check the open question from product.md: **does Chrome with several windows fit in 4 GB?** Open 4–5 windows on heavy sites and record memory use. If it doesn't fit, raise the instance size question with the founder.

Done when Chrome runs on both the local image and the AMI, survives a crash via restart, and the profile persists across restarts.
