---
id: "63475d"
title: Run Chrome on the VM under systemd
status: done
priority: none
labels:
  - browser
  - m8
  - vm
created_at: 2026-09-27T05:42:03.548Z
updated_at: 2026-10-02T01:21:43.721Z
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

Architecture: the local image is arm64 (docs/design.md §18), while production is x86_64. Check whether Google publishes Chrome stable for linux-arm64 today. If not, decide with the user between Chromium locally (and Chrome in production), or another way to keep the local and production browsers alike (profile format and CDP behaviour matter).

## As built

- `image/scripts/chrome.sh`: Chrome stable from Google's repository (published for arm64 too, same version, so no Chromium locally), Xvfb, CJK fonts; `xvfb` and `chrome` units as `winston`, profile on the data volume, DevTools on localhost:9222, memory limit 2.5 GB, restart after upgrades. On EC2 the build smoke-tests Chrome with its sandbox, and unattended-upgrades covers Google's repository.
- `winstond` (`chrome-watch.ts`): CDP probe every 30 s, `sudo systemctl restart chrome.service` after 60 s silent; skipped on images without Chrome.
- Local container: 1 GB shm and seccomp unconfined (keeps Chrome's sandbox on).
- Checked locally: crash restart, hang restart by winstond, profile across container restarts, localhost-only DevTools. Memory with 5 heavy sites: ~2 GB peak, fits 4 GB (product.md question answered).
- The AMI is built and checked after this commit (AMI workflow); existing production VMs get Chrome only on a new instance (the founder's next VM restore).

