# Winston — Implementation plan

This is the order in which Winston gets built. The tickets themselves live in `.moth/` (Moth tracks status and `blocked_by`, but not sequence). This document is the sequence.

- **Product:** [product.md](product.md)
- **Design & specifications:** [design.md](design.md) (Part 3 lists the invariants)
- **Research:** [research/](research/)

## How to work through it

1. **Take the next ticket in the order below** whose blockers are all done. `moth list --unblocked` shows what's available. The order below is the intended path, and `blocked_by` is the hard constraint.
2. **Re-check before starting.** Read the ticket, the tickets it depends on, and the current design doc sections it points to. Tickets were all written up front, so earlier work may have changed things. If reality has moved, adjust the ticket first (`moth edit`), in the same commit as the work.
3. **Claim it:** `moth move <id> in-progress`.
4. **One ticket = one commit.** The commit contains the work, any doc updates, and the ticket moved to `done`. Push after committing. From M4 on, every push to `main` deploys to production, so every commit must leave the system working.
5. **Keep the docs true.** When implementation finds a better approach than Part 3's sketch, do the better thing and update `docs/design.md` in the same commit. **Invariants** (design.md Part 3) change only after discussing with the founder.
6. **Collaborative tickets (🤝)** are done *with* the founder: things that happen in their accounts (AWS, Google, DNS, Telegram), decisions they asked to make, and work they want to shape directly (the design system, the dev design view, the handoff page on real phones, prompt polish, go-live). Don't complete these alone.
7. **New tools get researched properly.** Tickets that introduce a tool (a linter, formatter, framework, SDK, infrastructure tool) include research on its current configuration and how it fits with the rest before anything is set up.
8. **Tests** are called for where they matter, ticket by ticket, focused on deterministic code: envelopes, the queue, triggers, the agent loop with a scripted fake model, the CLI, permissions, and provider adapters. LLM judgment is evaluated through real use and the database log, not tests.
9. **The gate:** once the lefthook ticket lands (M0), formatting, linting, type checks, tests and commitlint run on every commit. Tickets don't repeat that.

## Milestones at a glance

| Milestone | Tickets | What works at the end |
|---|---|---|
| M0 Foundations | 1–14 | Toolchain, pre-commit gate, Postgres, config, logging, ids, CI checks |
| M1 Talk to Winston (local) | 15–35 | Chat with the dev bot: steering, typing, rolling window, failure handling |
| M2 His computer (local) | 36–54 | Local VM, `winstond`, gateway, bash/CLI, attachments, voice |
| M3 Accounts & website | 55–72 | Design system, sign-in, dev design view, sidebar app, Telegram linking, accounts, deletion |
| M4 Production | 73–93 | AWS, CI/CD, EC2 VMs, self-update, **go-live** |
| M5 Mail & calendar | 94–103 | `winston mail` / `calendar` / `accounts`, permissions, audit log |
| M6 Background agents | 104–113 | Delegation, durable runs, parking, compaction, crash safety |
| M7 Triggers & events | 114–128 | Proactivity: triggers, push + sync, matching, scheduler |
| M8 Browser | 129–141 | Chrome, `winston browser`, locks, handoffs, Jev autopilot |
| M9 Rounding out | 142–145 | History search, costs, prompt polish, docs sync |

**145 tickets, 12 collaborative.**

## The sequence

### M0 — Foundations
The repo, the toolchain, the pre-commit gate, Postgres, config, logging, ids and CI checks. Nothing user-facing yet.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 1 | `0fa82e` | Bootstrap the Bun workspace monorepo | — |
| 2 | `b1f904` | Write AGENTS.md with the repo's working principles | `0fa82e` |
| 3 | `746193` | Configure strict TypeScript for the workspace | `0fa82e` |
| 4 | `154525` | Set up Prettier for the whole repo | `0fa82e` |
| 5 | `991c7d` | Set up ESLint with type-aware typescript-eslint rules | `746193`, `154525` |
| 6 | `ac22b7` | Set up bun test and testing conventions | `746193` |
| 7 | `51d785` | Add lefthook pre-commit checks and commitlint | `991c7d`, `ac22b7` |
| 8 | `676648` | Run Postgres locally with Docker Compose | `0fa82e` |
| 9 | `29521a` | Add a typed, validated config loader | `746193`, `ac22b7` |
| 10 | `9378a8` | Add structured logging shared by all services | `29521a` |
| 11 | `2c5ac8` | Set up packages/db with Drizzle and SQL migrations | `676648`, `29521a` |
| 12 | `fc638d` | Build a Postgres-backed test harness | `2c5ac8`, `ac22b7` |
| 13 | `5b4554` | Generate typed, prefixed ids | `ac22b7` |
| 14 | `021c52` | Run the checks on GitHub Actions | `51d785`, `fc638d` |

### M1 — Talk to Winston (local)
Message @RunWinstonDevBot and the front of house replies, with steering, typing, a rolling window and failure handling. The user comes from a seed script.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 15 | `16c290` | Decide and set up the local webhook tunnel (with the founder) 🤝 | `0fa82e` |
| 16 | `762cf0` | Add identity tables and a dev seed script | `2c5ac8`, `fc638d`, `5b4554` |
| 17 | `c5850d` | Add conversation and run tables | `762cf0` |
| 18 | `87ce11` | Add model-call, prompt-version and cost tables | `c5850d` |
| 19 | `9869b7` | Build the Postgres job queue | `2c5ac8`, `fc638d`, `5b4554`, `9378a8` |
| 20 | `5cbe5b` | Create the agents service worker loop | `9869b7`, `29521a` |
| 21 | `76c143` | Create the api service with Hono | `29521a`, `9378a8` |
| 22 | `6bac51` | Add a single `bun dev` command for local development | `76c143`, `5cbe5b`, `16c290`, `676648` |
| 23 | `e47a50` | Receive Telegram messages via webhook | `76c143`, `c5850d`, `9869b7` |
| 24 | `db2a16` | Render inbound items into XML envelopes | `c5850d`, `ac22b7` |
| 25 | `9f3814` | Create the prompts package with a first front-of-house prompt | `87ce11` |
| 26 | `0bfb79` | Build the model gateway on the Vercel AI SDK and OpenRouter | `29521a`, `9378a8` |
| 27 | `36a9c9` | Record every model call and its cost | `0bfb79`, `87ce11` |
| 28 | `cb9674` | Run a minimal front-of-house turn that can reply | `5cbe5b`, `db2a16`, `9f3814`, `36a9c9`, `e47a50` |
| 29 | `ed1e47` | Format and deliver outbound Telegram messages | `cb9674` |
| 30 | `f661c5` | Show a typing indicator while Winston works | `cb9674` |
| 31 | `eeb50f` | Serialize front-of-house turns per user and coalesce bursts | `cb9674` |
| 32 | `d4bb0d` | Steer running turns with new input and drop stale replies | `eeb50f`, `ed1e47` |
| 33 | `ebd998` | Trim the front-of-house window and place cache breakpoints | `cb9674` |
| 34 | `8d94b2` | Deliver Telegram reactions to Winston | `e47a50`, `db2a16` |
| 35 | `3f95f4` | Handle model failures and refusals in the front of house | `cb9674`, `36a9c9` |

### M2 — His computer (local)
Winston gets his own (local Docker) computer: `winstond`, `gateway`, `bash`, `view_image`, the CLI skeleton, attachments in and out, and voice notes.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 36 | `307272` | Validate running systemd inside Docker on macOS | `0fa82e` |
| 37 | `ea07c8` | Create the Packer template and provisioning scripts for the local image | `307272` |
| 38 | `03156b` | Add VM and file tables | `762cf0` |
| 39 | `2dd479` | Define the VmProvider interface with a Docker implementation | `ea07c8`, `03156b` |
| 40 | `4e6f9b` | Create the gateway service and VM registration | `03156b`, `29521a`, `9378a8` |
| 41 | `6dc140` | Build the winstond daemon skeleton | `4e6f9b`, `ea07c8` |
| 42 | `6bde95` | Execute shell commands on the VM over the websocket | `6dc140` |
| 43 | `980988` | Read and write VM files over the websocket | `6bde95` |
| 44 | `737b8c` | Give agents the bash tool | `6bde95`, `cb9674` |
| 45 | `68e9cc` | Add the view_image tool | `980988`, `737b8c` |
| 46 | `8251fd` | Serve the VM-facing API through winstond and gateway | `6dc140`, `737b8c` |
| 47 | `ae2a73` | Build the winston CLI skeleton and its conventions | `8251fd` |
| 48 | `253db2` | Parse human times in the user's time zone | `ae2a73` |
| 49 | `245cbb` | Bake the CLI and winstond binaries into the image | `ae2a73`, `6dc140`, `2dd479` |
| 50 | `961613` | Provision the seeded user's local VM in bun dev | `245cbb`, `6bac51` |
| 51 | `ca5d9c` | Save inbound Telegram attachments to the VM and show them to the model | `980988`, `cb9674` |
| 52 | `68fe0c` | Let send_message deliver files from the VM | `980988`, `ed1e47` |
| 53 | `0e0c6c` | Transcribe voice notes | `ca5d9c`, `0bfb79` |
| 54 | `bbfa17` | Teach the front of house about its computer | `737b8c`, `ae2a73`, `68e9cc` |

### M3 — Accounts & website
The web app: design system (with the founder), sign-in with the allowlist, the dev design view (with the founder), sidebar shell, home, Telegram linking, connected accounts and permissions, profile, deletion.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 55 | `ef5b35` | Set up the Google Cloud project and OAuth clients (with the founder) 🤝 | `16c290` |
| 56 | `6b393b` | Scaffold the web app with TanStack Start, Tailwind and its lint setup | `51d785`, `6bac51` |
| 57 | `801d97` | Build the design system foundations with the founder 🤝 | `6b393b` |
| 58 | `ea7ecd` | Add web session and Telegram link token tables | `762cf0` |
| 59 | `244f55` | Sign in with Google, gated by the email allowlist | `ea7ecd`, `801d97`, `ef5b35` |
| 60 | `7b6af9` | Build the dev design view with the founder 🤝 | `244f55` |
| 61 | `5e3c6d` | Build the app shell with sidebar navigation | `7b6af9` |
| 62 | `b0717f` | Add the public homepage, privacy policy and terms | `5e3c6d` |
| 63 | `0a5f39` | Provision a computer when a user signs up | `244f55`, `2dd479` |
| 64 | `bb2d67` | Build the home page with the setup checklist | `5e3c6d`, `0a5f39` |
| 65 | `ee16f5` | Link Telegram from the web app | `bb2d67`, `ea7ecd`, `e47a50` |
| 66 | `35fdd4` | Add connection storage with encrypted tokens | `762cf0` |
| 67 | `4428cf` | Connect Google mail and calendar accounts | `35fdd4`, `5e3c6d`, `ef5b35` |
| 68 | `89a2b0` | Build the account page with capability toggles | `4428cf` |
| 69 | `6882fb` | Refresh Google tokens and warn before they expire | `4428cf` |
| 70 | `988f4d` | Build the profile page and keep the time zone current | `5e3c6d` |
| 71 | `22f09d` | Delete an account and everything in it | `988f4d`, `89a2b0`, `0a5f39` |
| 72 | `50fa25` | Add a script to manage the email allowlist | `244f55` |

### M4 — Production
Everything runs in AWS and every push to `main` deploys. It ends with go-live, and from then on the founder uses the real @RunWinstonBot daily.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 73 | `2c0dbe` | Set up the AWS Organization and the winston-prod account (with the founder) 🤝 | `0fa82e` |
| 74 | `60490f` | Create the CDK app skeleton | `2c0dbe`, `51d785` |
| 75 | `2a17a6` | Build the network stack | `60490f` |
| 76 | `f25d3b` | Build the data stack: RDS, KMS keys and S3 buckets | `2a17a6` |
| 77 | `f92c63` | Set up DNS and certificates for runwinston.com (with the founder) 🤝 | `60490f`, `16c290` |
| 78 | `78c130` | Write production Dockerfiles for the four services | `76c143`, `5cbe5b`, `4e6f9b`, `6b393b` |
| 79 | `2ca5a6` | Wire production secrets and the KMS token vault | `f25d3b`, `35fdd4` |
| 80 | `a4de0d` | Store screenshots and attachments in S3 in production | `f25d3b`, `68e9cc` |
| 81 | `071e49` | Build the services stack on ECS Fargate | `2a17a6`, `f25d3b`, `f92c63`, `78c130`, `2ca5a6` |
| 82 | `8203ff` | Serve the web app through CloudFront | `071e49` |
| 83 | `ce9145` | Build the production AMI with Packer | `245cbb`, `f25d3b` |
| 84 | `b9062e` | Build the VM stack: launch template, security and snapshots | `2a17a6`, `ce9145` |
| 85 | `550446` | Implement the EC2 VmProvider | `b9062e`, `2dd479` |
| 86 | `9f2e3f` | Sign VM binaries and let winstond update itself | `f25d3b`, `245cbb` |
| 87 | `45b4ce` | Let GitHub Actions deploy via OIDC | `60490f` |
| 88 | `e1a361` | Deploy to production on every push to main | `071e49`, `8203ff`, `45b4ce`, `9f2e3f`, `021c52` |
| 89 | `dd8241` | Add budget alerts and model spend limits | `60490f` |
| 90 | `1e6482` | Configure production Telegram, Google and API keys (with the founder) 🤝 | `2ca5a6`, `071e49`, `ef5b35` |
| 91 | `1867ba` | Run one-off admin commands in production | `071e49` |
| 92 | `f2ce33` | Restore a user's VM from a snapshot | `550446`, `b9062e` |
| 93 | `c0cba0` | Go live: first production deploy and end-to-end check (with the founder) 🤝 | `e1a361`, `550446`, `1e6482`, `1867ba`, `22f09d`, `ee16f5`, `6882fb`, `bbfa17`, `3f95f4`, `ebd998`, `d4bb0d`, `8d94b2`, `f661c5`, `0e0c6c`, `68fe0c`, `a4de0d` |

### M5 — Mail & calendar
Winston reads and acts on mail and calendars through `winston mail`, `winston calendar` and `winston accounts`, with server-enforced permissions, an audit log and confirm-first behaviour.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 94 | `480aff` | Build the connector framework: providers, permission enforcement and the audit log | `8251fd`, `6882fb`, `89a2b0` |
| 95 | `6af84b` | Read mail from Gmail | `480aff` |
| 96 | `fc5532` | Add winston mail list, search, get and download | `6af84b`, `253db2` |
| 97 | `d66d10` | Send, reply, forward and organize mail via Gmail | `6af84b` |
| 98 | `837a29` | Add winston mail send, reply, forward, update and delete | `d66d10`, `fc5532` |
| 99 | `403364` | Read calendars from Google Calendar | `480aff` |
| 100 | `cfff20` | Create, update, delete and RSVP to calendar events | `403364` |
| 101 | `c7b3fa` | Add the winston calendar commands | `cfff20`, `253db2` |
| 102 | `fe870e` | Add winston accounts and the generic winston get | `480aff` |
| 103 | `f6613f` | Teach Winston confirm-first and how to use mail and calendar | `837a29`, `c7b3fa`, `fe870e` |

### M6 — Background agents
Durable background agents: delegation, results through the front of house, `winston task`, parking, compaction, the front-of-house step budget, effort escalation and crash safety.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 104 | `64a47f` | Build the durable background-run engine | `737b8c`, `68e9cc`, `36a9c9` |
| 105 | `ea88cd` | Write the background agent's system prompt | `64a47f` |
| 106 | `438b86` | Let the front of house delegate work | `64a47f`, `ea88cd` |
| 107 | `1fd02f` | Report background results back through the front of house | `438b86` |
| 108 | `6abd88` | Add winston task list, get, cancel and resume | `1fd02f`, `fe870e` |
| 109 | `ac0f5f` | Park runs on handoff and resume them | `6abd88` |
| 110 | `5714b6` | Compact long background runs by summarization | `64a47f` |
| 111 | `5cd9eb` | Cap front-of-house turns and hand the rest to a background agent | `438b86` |
| 112 | `12c38a` | Let runs raise their own effort | `6abd88` |
| 113 | `77ebe8` | Make background runs safe across crashes and deploys | `64a47f`, `d66d10` |

### M7 — Triggers & events
Proactivity: the event catalog, triggers (schedules and subscriptions), push notifications and sync for Gmail and Calendar, matching and batching, the scheduler, derived timers.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 114 | `9c407f` | Define the event catalog and events table | `480aff` |
| 115 | `88f5ee` | Add trigger tables and encode the trigger lifecycle | `9c407f` |
| 116 | `595766` | Add winston trigger create, list, get, update and delete | `88f5ee`, `253db2` |
| 117 | `3f6521` | Start background runs from fired triggers | `88f5ee`, `1fd02f` |
| 118 | `e79d1c` | Run the trigger scheduler | `3f6521` |
| 119 | `9751a9` | Manage the GCP Pub/Sub setup with Terraform | `ef5b35`, `e1a361` |
| 120 | `70194e` | Receive Gmail push notifications and keep watches alive | `9751a9`, `9c407f` |
| 121 | `f81278` | Turn Gmail history into mail events | `70194e`, `6af84b` |
| 122 | `a2d498` | Receive Calendar push notifications and keep channels alive | `9c407f`, `403364` |
| 123 | `6a3656` | Turn calendar changes into calendar events | `a2d498` |
| 124 | `16b185` | Reconcile connections periodically | `f81278`, `6a3656` |
| 125 | `463072` | Match events to subscriptions and fire them in batches | `f81278`, `6a3656`, `3f6521` |
| 126 | `4da088` | Fire calendar.event.starting from derived timers | `463072`, `e79d1c` |
| 127 | `0512b5` | Wire the system events into subscriptions | `463072`, `89a2b0`, `988f4d` |
| 128 | `fa537d` | Teach Winston to use triggers well | `595766`, `4da088`, `0512b5` |

### M8 — Browser
The browser: Chrome on the VM, `winston browser`, domain locks, handoff links with a mobile live view, the full-desktop fallback, and the Jev autopilot.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 129 | `63475d` | Run Chrome on the VM under systemd | `ce9145`, `961613` |
| 130 | `6b73c4` | Connect the CLI to Chrome and manage agent windows | `63475d`, `fe870e` |
| 131 | `5f5b39` | Snapshot pages as compact element lists with refs | `6b73c4` |
| 132 | `0451df` | Act on pages: click, type, select, press, scroll, wait | `5f5b39` |
| 133 | `1d60a8` | Add browser screenshot and eval | `6b73c4` |
| 134 | `17f478` | Lock websites per agent to avoid collisions | `0451df` |
| 135 | `f0507c` | Create handoff links and stream a tab's screencast | `6b73c4`, `ac0f5f` |
| 136 | `ff4636` | Build the handoff live-view page and test it on phones (with the founder) 🤝 | `f0507c`, `7b6af9` |
| 137 | `732b45` | Offer a full-desktop fallback for native browser dialogs | `f0507c` |
| 138 | `b782bc` | Proxy Jev through the backend and log its decisions (with the founder for access) 🤝 | `480aff` |
| 139 | `91faf5` | Add browser autopilot, the Jev fast path | `b782bc`, `0451df`, `17f478` |
| 140 | `3d5f3d` | Teach Winston to browse well | `91faf5`, `1d60a8`, `ff4636`, `732b45` |
| 141 | `26dfa2` | Exercise real browser tasks end to end (with the founder) 🤝 | `3d5f3d`, `63475d` |

### M9 — Rounding out
History search, cost reporting, prompt polish from real use (with the founder), and a final docs sync.

| # | Ticket | Title | Blocked by |
|---|---|---|---|
| 142 | `35c1ed` | Add winston history search and get | `fe870e`, `1fd02f`, `d66d10` |
| 143 | `46ee9b` | Report per-user spend | `1867ba`, `b782bc`, `0e0c6c` |
| 144 | `62e3d2` | Review and refine the prompts from real use (with the founder) 🤝 | `26dfa2`, `fa537d`, `35c1ed` |
| 145 | `503aaa` | Bring the docs in line with what was built | `62e3d2`, `46ee9b` |
