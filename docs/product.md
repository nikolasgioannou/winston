# Winston — Product

> Status: built and in daily use since 2026-09-30. First captured through a structured Q&A ("grill me") session; kept in line with what was built (docs/design.md has the details).

Winston is a personal executive assistant that lives in Telegram. You can chat with him, but he also acts on his own: he texts you before meetings, flags important emails, and follows up on things without being asked. He has his own computer and is excellent at using a web browser.

## 1. Vision & audience

- **Audience:** the founder plus a small group of friends. This is an invite-only, small multi-user product, not a public launch.
- **Access is allowlisted by email.** Only allowlisted Google accounts can sign up or sign in. To start with, the allowlist is just the founder's email. Friends are added one by one.
- **Signup:** a user signs up with "Sign in with Google." This is **identity only**. It does not grant Gmail or Calendar access. Signing up provisions the user's own VM.
- **Connected apps are separate from sign-in.** After signing in, the user connects any number of accounts: for example, **work Gmail + personal Gmail + work Calendar + personal Calendar**. Each connection is its own Google authorization, with its own permissions.
- Each user gets their own Winston, with separate memory, VM and connected accounts.

### Onboarding flow (Google first)

1. The user visits the Winston site and signs in with Google (identity only).
2. Their account is created and VM provisioning starts.
3. The site shows a **"Connect Telegram"** button, plus a QR code for users on desktop.
4. The button opens Telegram at `t.me/RunWinstonBot?start=<one-time-token>`. The user taps **Start**.
5. The bot receives `/start <token>`, links that Telegram chat to the account, and Winston sends a brief hello.
6. The user connects apps (Gmail, Calendar) on the site, as many accounts as they like, at any time. This can happen before or after linking Telegram.
7. From then on, all conversation happens in Telegram. The site does not have chat.

**No special onboarding.** Winston doesn't run a "getting to know you" study or pre-configure anything. The user guides him, and he learns and sets up triggers as they talk.

### The website

A small web app with a **sidebar**. All chat happens in Telegram.

- **Home:** Winston's status, and the first-run setup checklist until everything is connected (computer ready, Telegram linked, first account connected).
- **Connected accounts:** connected mail and calendar accounts (multiple per app: work and personal), each with its own **capability toggles** (for example, work mail: read / draft only; personal mail: read / draft / send), enforced by the server.
- **Channels:** the ways you reach Winston: Telegram linking (also on Home's setup checklist), and Winston's own email address.
- **Profile:** first and last name, email, and account deletion (destroys the computer and wipes everything).
- **No behavior-specific settings** (for example, no "ping me N minutes before meetings"). See §3.
- **No history page.** Conversation lives in Telegram. Background runs and triggers are internal.

## 2. Core experience (Telegram)

- You talk to Winston in a Telegram chat.
- **Inbound media.** The user can send:
  - **Voice notes:** transcribed, then treated like typed text (marked as coming from voice).
  - **Photos and screenshots**, **documents and any other files.** Every file is **saved to Winston's computer** and **also given to the model** directly when the model can read it (images, PDFs, text). Other file types are passed by path, and Winston opens them with tools on his VM.
  - **Forwarded messages:** Winston is told who originally sent them.
- **Outbound media.** Winston sends text, and can also send **photos and files from his computer** (for example, a screenshot of a booking confirmation, or a downloaded PDF).
- **Winston must feel fast.** A quick "front-of-house" agent always answers right away. It never goes silent because it is busy with a long task.
- **Quick things happen right away; longer work is delegated to background agents.** The front of house does anything quick itself (checking the calendar, sending a confirmed reply, peeking at a page). Anything longer runs in the background, in parallel. The front of house acknowledges each task, stays available for chat, and reports back when a task finishes.
- Several tasks can be in progress at once, and each one may report back or ask for help on its own.

## 3. Proactive behaviors

**Principle: no hard-coded features.** Winston does not have a "meeting reminder" feature or an "email alert" feature. Proactive behavior comes from general building blocks:

- **Schedules:** Winston can set one-off or recurring wake-ups for himself, each with a note about what to do.
- **Subscriptions:** Winston can subscribe to events from connected apps (a new email, a calendar change, a newly connected app), optionally with his own filters. He decides what he listens to.
- **Memory:** what he has learned about what the user cares about.
- **Judgment:** deciding whether something is worth a message.

"Texting before a meeting" is something Winston _chooses_ to do: he reads the calendar, knows the user likes a heads-up, and schedules a wake-up. It is not a product feature. Preferences are expressed in conversation ("don't bother me about newsletters") and remembered. They are not set through settings toggles.

Examples of emergent behaviors:

- Texting before meetings, with useful context.
- Texting when interesting emails come in.

## 4. Capabilities & connected apps

- **Mail (Gmail) and calendar (Google Calendar)**: reading _and_ acting (sending, drafting, creating/updating events, RSVPs), subject to each connection's permission toggles (§6).
- His own computer (a VM).

### Browser use (a core strength)

- Winston should be **exceptional at using a web browser**.
- **Watching:** from a link Winston sends, the user opens **Winston's browser** (signed in, on their phone or laptop) and can watch any of his windows live while he works, and take one over themselves at any time. It isn't in the site's navigation: the links are the way in.
- **Handoff:** when he gets stuck (a login, a CAPTCHA, 2FA, an ambiguous choice), he sends the user a **link** to that window on the browser page, with a button that signs them in through Telegram. It's their turn there.
- **Resume:** the user taps **Done** on the page, or sends Winston a quick message ("done"), and the task picks up where it left off. The page keeps showing the window afterwards.
- **Full desktop:** for native pop-ups the tab's view can't show (dropdowns, file pickers), a button on the page shows Winston's whole screen.
- Parallel background tasks can each have their own browser; the page lists every window and what it's for.

## 5. Personality & voice

Winston is a **competent, discreet chief of staff**.

- **Brief by default.** Messages read like texts from a sharp human assistant: "Your 3pm with Dana moved to 4. Nothing else changes." No filler ("Great question!"), no essays, no emoji spam.
- **Leads with the conclusion** and offers detail on request.
- **Has opinions when asked** and makes recommendations, not just lists of options.
- **Warm but not chummy.** Light dry wit is fine.
- Referred to as he/him.
- The base personality is fixed (it lives in the static system prompt). Per-user adjustments ("be more casual", "call me Nik") are just notes Winston keeps and follows. Nothing to build.

## 6. Trust, permissions & privacy

Winston **can act on the user's behalf**: send emails, create or delete calendar events, and so on.

### Identity

- **Winston acts as the user** in the user's own things: their Gmail, their logged-in browser, bookings in their name. When he writes on the user's behalf in an assistant voice in the user's threads, he does it from the user's own email (for example, signing "Winston, on behalf of Nik").
- **His own email address (being built, ead827).** The user can turn on an address for Winston, `<name>@runwinston.email`, from the site's Channels page, picking the name then. He uses it to sign up for things in his own name and read their verification codes, and the user forwards mail to him or CCs him to hand work off. The name is the user's choice, may be changed twice (old addresses keep delivering), and is never given to anyone else, even after the account is deleted. Turning it off makes mail to it bounce until it's on again.
- **He has no phone number of his own.** Verification codes sent to the user's email are read through Gmail, and SMS codes are handled through a handoff.

Trust is controlled in two layers:

1. **Per-connection permissions (hard).** On the site, each connected account lists its capabilities, and the user switches them on or off. Example for a mail account: _read_ ✅, _draft_ ✅, _send_ ❌. A disabled capability simply doesn't exist for Winston. The server refuses it no matter what he tries.
2. **Confirm-first norms (soft).** For enabled capabilities that reach other people (sending an email, inviting someone, changing a shared meeting), Winston's instructions say to **confirm in chat before acting**: "Here's the reply to Sam: '…'. Send it?" There is **no special tool-confirmation machinery** (no approval buttons, no gated tool calls). It is just Winston behaving like a good assistant, and the user replies in plain chat.

The hard layer is the safety net. For example, a malicious email trying to trick Winston into sending mail fails if _send_ is off, whatever the soft layer does.

## 7. Out of scope

Decided _not_ to build:

- Chat on the website. Telegram is the only conversation surface.
- A history page, trigger/watch list, or memory viewer on the site.
- Behavior-specific settings (for example, meeting-reminder timing).
- A dedicated onboarding study. The user guides Winston.
- Tool-approval machinery (approval buttons, gated tool calls).
- Winston's own phone number.
- Public signup. Access is by email allowlist.
- Google OAuth production verification. The app stays in testing mode.
- Observability/eval tooling. The database is the record.
- Per-user spend caps, rate limits or concurrency limits (only a per-run step cap). Account-wide, there is an OpenRouter monthly credit limit and AWS budget alerts; per-user spend is reported (`bun run prod costs`).

## Open questions

- ~~Does Chrome with several agent windows fit comfortably in a 4 GB `t3a.medium`?~~ Measured locally (arm64 Docker, not yet on EC2): five heavy sites peak at about 2 GB (2026-10-01), a few windows of real tasks about 0.7 GB (2026-10-02). Yes for now; revisit if many agents browse at once (docs/design.md §18).
- ~~Jev access~~ Answered 2026-10-02: OpenRouter serves Jev through its alpha decisions API, on the key Winston already has, so no waitlist. The endpoint is alpha and may change; the browser loop works without it.
- ~~Will the founder's work (Workspace) account allow connecting an unverified app?~~ Yes for `ni@nikolas.ai` (checked 2026-09-28; docs/runbooks/google-cloud.md). That domain owns the Google Cloud project, so friends' work domains may still block it.
- ~~Mobile quality of the handoff live view~~ The founder used it on their phone in production (2026-10-02): it worked well, and Done moved onto the page at their request. Android is untested; further tweaks come from use.
- ~~Do sites block Winston's AWS address?~~ Mostly no. In his real Chrome on the production VM (2026-10-02): OpenTable, Zillow and Booking.com load normally; Ticketmaster shows a bot check and Reddit blocks it. (Plain requests without a browser are refused far more often.) A residential proxy or a handoff covers the few that block; revisit if more do.
