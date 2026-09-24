# Winston

A personal sidekick with Telegram as its conversational interface.

## Development

Use the Bun and Node versions pinned in `mise.toml`. With those versions already installed, run commands from this directory:

```sh
mise exec -- bun install --frozen-lockfile
mise exec -- bun run hooks:install
mise exec -- bun run typecheck
mise exec -- bun run build
mise exec -- bun run dev
```

`dev` starts the web app on `127.0.0.1:5173`. Visit `/__dev/design` to review shared components and page states without external services; review modules are excluded from production builds. The root page supports Google sign-in and sign-out. Product management pages follow separately. `dev:server` starts the API on `127.0.0.1:3001` and reads the root `.env.local`. The workspace runs in its Linux container; the CLI entrypoint is still an empty module. Automated checks use synthetic credentials and disposable databases.

The API exposes `/health/live` for process liveness and `/health/ready` for startup and dependency readiness. Startup requires a compatible migrated database and complete authentication configuration. Callback, owner, device, and task route groups have separate authenticators and reject access by default. Owner routes validate database sessions and the verified email allowlist on every request; mutations also require the configured web origin. Other authority implementations arrive separately. Request errors use stable codes and server-generated correlation IDs. Request logs contain only correlation ID, status, and duration, excluding request content and raw exceptions. SIGINT/SIGTERM stop new connections and drain active requests, forcing closure after the configured timeout.

## Native development

The Swift protocol and transport packages target macOS 14 and later and use the installed Swift 6 toolchain. `bun run test:native` runs shared protocol fixtures and real Foundation-to-Bun loopback tests on macOS. `bun run format:native` applies the toolchain's Swift formatter; `format:native:check` checks without rewriting files and runs in pre-commit and macOS CI. No separate global formatter installation is needed. The transport tests use synthetic credentials and do not pair this Mac or request privacy permissions.

## Production container

Build the web app and API together with `docker build -t winston .`. The pinned Bun image installs frozen dependencies and runs as a non-root user on port 8080. The build context excludes local environment files, Git metadata, and installed dependencies. Supply runtime secrets through the deployment environment; never add them to the image.

Apply migrations before starting the server with `bun packages/adapters/src/database/migrate.ts` inside the image, using `DIRECT_DATABASE_URL`. The container sets `WEB_ASSET_DIRECTORY=/app/public` to serve the built web app and API from one origin. Keep this variable unset during local Vite development. Application pages use the SPA entrypoint; missing assets, reserved API paths, and development review URLs return their own errors rather than the page. Fingerprinted assets have immutable caching; HTML remains uncached.

`fly.toml` configures the trusted web/API service in IAD with HTTPS, readiness checks, a 30-second shutdown allowance, and one shared CPU with 1 GB of memory per Machine. Automatic stopping is disabled so conversation workers stay available. Stage separate production secrets on the app, then deploy with `fly deploy --remote-only --depot=true --ha=false`; the remote builder avoids x86 emulation on Apple Silicon. The initial deployment uses one Machine; this is not a redundant service, and rolling updates can briefly interrupt requests. The release command applies migrations through `DIRECT_DATABASE_URL` and stops deployment if they fail. This service must never run untrusted workspace commands or receive a workspace volume. Cloud workspace provisioning and GitHub deployment automation are separate work.

## Action approvals and dispatch

Action preparation stores the exact arguments, target, policy snapshot and a stable operation ID before execution. An action key cannot be reused with changed arguments. Owner decisions must match both the action revision and canonical request hash; approvals expire after fifteen minutes. Normal waiting/resume and worker claims preserve the task's instruction revision, while every steering operation advances it, including a return to identical wording.

Dispatch atomically locks and revalidates the current task lease, instruction revision, policy and resource before recording `dispatching`. Commit that transaction before contacting an executor. Cancellation that commits first prevents dispatch; cancellation after dispatch cannot promise that an external effect was undone. Duplicate claims never issue a second dispatch receipt. Lost or interrupted execution becomes `unknown`, which cannot be automatically dispatched again. Trusted adapters can reconcile it only from independently verified executor/provider evidence. Outcome recording does not resume or change a canceled task. Owner decisions and reconciliation are internal repository boundaries; they are not model tools or unauthenticated HTTP endpoints.

## Workspace operation storage

Trusted provisioning registers each cloud workspace under its owner in a paused state. Activation, pausing and retirement use revision checks; every lifecycle change invalidates previously issued execution capabilities, and retirement cannot be undone by registering the same ID again. Worker orchestration issues execution credentials only for an active owned workspace and a running, leased task. No HTTP route issues these credentials.

`POST /api/tasks/workspaces/:id/authorize` revalidates a worker bearer credential and its `X-Winston-Worker` identity against the exact owner, workspace, task revision and generation in the operation envelope. It checks the current workspace lifecycle revision and rejects credentials issued for workspace/CLI or device callers. This endpoint is a dispatch-time authorization check, not a reusable approval or an execution queue; the runtime must make a fresh check immediately before acting.

The workspace journal binds an explicitly initialized volume to one owner and workspace. Ordinary opening requires its existing control directory, home and journal; missing storage never creates a replacement home. Its SQLite WAL uses full synchronous commits. Operation IDs bind the task revision, generation, operation kind and input hash. Exact retries return the existing state, while changed inputs conflict. Completion requires the original private completion token and cannot overwrite a terminal result. After interrupted execution is known to have stopped, recovery marks unfinished records `unknown`; it never reruns them.

This journal is a storage primitive, not an authorization decision or a command runner. The execution host must hold exclusive process ownership, keep the control directory inaccessible to command users, compute the input hash itself, and revalidate current task authority before dispatch. Copying only the SQLite main file while it is active is not a valid backup; preserve the WAL or use an SQLite-consistent snapshot. Linux privilege separation and volume provisioning are implemented separately.

The workspace HTTP handler supports `POST /v1/inspect` and `POST /v1/status` with an exact operation and empty input object. It recomputes the input hash and checks the worker credential online before journal access, including duplicate requests and status reads. Authority requests have a five-second deadline, bounded responses, and reject redirects; no cookies are forwarded. The handler exposes no shell or file operations yet. Its Linux host sets a 16 KiB request body limit and a ten-second idle timeout.

Build the workspace image with `docker build -f apps/workspace/Dockerfile -t winston-workspace:local .`. Mount an existing volume at `/data` and set `WORKSPACE_OWNER_ID`, `WORKSPACE_ID`, and `WORKSPACE_AUTHORITY_ORIGIN`. Run the image once with `--initialize` to create an empty home and journal, then run it without arguments. Initialization exits and refuses already initialized storage. Do not pass database, model-provider or deployment credentials to this container.

The entrypoint requires a real volume mount with a root-owned directory that other users cannot write. A kernel lock prevents a second runtime from opening it concurrently. Startup stops prior execution-user processes before recovering uncertain operations. The runtime and its configuration belong to root; `/data/home` belongs to UID/GID 1000. The image removes setuid/setgid bits. Local integration tests build this image and verify protected-file access, exclusive ownership and crash recovery on disposable volumes, including with a read-only root filesystem. Fly deployment must additionally isolate its network from databases and other owners; container user permissions are not a network boundary.

## Google sign-in

Set `DATABASE_URL`, `DIRECT_DATABASE_URL`, `BETTER_AUTH_URL`, `WEB_ORIGIN`, `BETTER_AUTH_SECRET` (at least 32 random characters), `OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in the root `.env.local`. Use a local database and a development Google Web application client. Register `http://127.0.0.1:3001/api/auth/callback/google` as its redirect URI. Run `bun run db:migrate`, then `bun run dev:server` and `bun run dev` in separate terminals. Open `http://127.0.0.1:5173`; Vite proxies `/api` to the local API. Use `127.0.0.1` consistently for local cookies and redirects. Production requires HTTPS origins, a separate OAuth client, and same-origin API routing.

Better Auth requests only Google identity scopes. The server fixes the provider, scopes, and return destination, rejects unverified or non-allowlisted identities on new and returning logins, and disables account linking. Sessions use HTTP-only cookies, secure cookies on HTTPS, database-backed OAuth state, and no cookie session cache. Stored login tokens are encrypted with the auth secret. Gmail/Calendar connections use separate `GOOGLE_CONNECTOR_CLIENT_ID` and `GOOGLE_CONNECTOR_CLIENT_SECRET` variables and the credential encryption configuration below. Their callback is `/callbacks/google/connections` on the API origin.

After signing in, use Connect Gmail or Connect Calendar to authorize each account. The connector requests offline access, one service's scopes, and identity information; it binds one-time state, PKCE and nonce to the initiating owner session. Reconnect requires the same stable Google account ID. Additional accounts do not create app users or change the sign-in allowlist. Calendar selection validates IDs against that account's current calendar list. Partial scope grants remain visible as limited access. Google External/Testing connector refresh tokens generally expire after seven days; production consent configuration remains separate from the local consent flow. API permissions do not themselves approve sending mail or modifying events.

Trusted connector calls refresh access tokens when less than a minute remains. A PostgreSQL transaction advisory lock serializes refresh per owner/connection across processes, with bounded provider requests and no automatic request retries. Encrypted credential revision checks prevent stale refresh results from overwriting reconnects or disconnects. Rotated refresh tokens are preserved; transient provider failures leave stored grants intact, while rejected grants require reconnection. Health transitions publish durable events for task/handoff consumers; reconnecting alone does not resume work or bypass current permission checks.

Disconnect removes that connection's credentials from Winston and invalidates credentials bound to their revision. It does not call Google's project-wide revocation endpoint, which can also invalidate Gmail, Calendar, and sign-in grants for the same Google account. To revoke the project's Google access altogether, remove it in your Google account permissions. Requests already sent to Google cannot be recalled by disconnecting.

The server build keeps `@winston/adapters` external so migrations resolve beside their package rather than beside the bundled server. Deployment must include that workspace, its migrations, and installed runtime dependencies.

## Credential storage

Connector grants use `@winston/adapters/credentials`, separate from Better Auth login credentials. Trusted connector services read `CREDENTIAL_ACTIVE_KEY` and `CREDENTIAL_KEYS` (a JSON map of key IDs to independently generated 32-byte base64 keys). AES-256-GCM binds each encrypted record to its owner, credential ID, provider, revision and key version. Database records never contain plaintext provider tokens. Revocation removes the encrypted grant and advances its revision; stale refresh attempts cannot restore it.

To rotate, deploy both old and new keys with the new key active, re-encrypt each live credential through the vault's revision-checked rotation method, verify all live records use the new key, then retire the old key from runtime configuration. Keep old keys separately protected for the retention period of backups that still need them. Losing a required key means reconnecting that account; it cannot be reconstructed from the database. Never log grants, keys or returned capability tokens.

Service capabilities are random, hash-stored, revocable tokens limited to one subject kind, subject, operation, resource and current task lease. They expire within five minutes and become invalid when their task is steered, canceled or loses its lease, or when a bound credential changes. The trusted broker must verify resource ownership and permission policy before issuance and revalidate the capability immediately before dispatch. These primitives are not exposed through model tools or public issuance routes. Owner sessions, desktop pairing and service capabilities are separate credentials; a workspace token cannot authenticate as a worker or device. Winston's computer and desktop proxy must never receive database URLs, encryption keys, Google refresh tokens or Fly deployment credentials.

## Owner timezone

The authenticated page synchronizes the browser's IANA timezone on opening and foreground return. This is a background operation; failures preserve the last valid profile and never block navigation. The owner API exposes `GET` and `PUT /api/owner/timezone`. Updates carry the profile revision; competing updates return 409 and the client makes a fresh observation before one bounded retry. Identical updates are idempotent and invalid timezone observations leave the profile untouched. New owners explicitly default to UTC.

`@winston/contracts/timezone` contains shared API validation and timestamp snapshots with a UTC instant, timezone, and date-specific offset. Message ingestion will persist those snapshots rather than recomputing history from the current owner profile. The timezone API does not modify historical messages or scheduled instants. Contracts include standard web type definitions because Zod's declarations reference URL; they perform no I/O.

For live model validation, copy `.env.example` to `.env.local` at the repository root and set `OPENROUTER_API_KEY` to a development key. `.env.local` is ignored by Git; `.env.example` contains placeholders only. The automated quality checks do not need this key. Keep provider credentials server-side and never expose them through `VITE_` variables. Additional environment variables will be documented as their integrations are implemented.

## Design principles

Every visible element must earn its place. Include text, controls, icons, and containers only when they support a user action, decision, navigation, or necessary status. Prefer clear labels and concise actionable feedback. Avoid redundant headings, obvious instructions, decorative filler, implementation commentary, and explanations of what the interface already shows. Apply this standard to product pages and development review surfaces alike; retain accessibility labels and useful error guidance.

## Device registration

Device registration uses owner routes under `/api/owner/devices`: create or cancel a five-minute pairing challenge, list or rename installations, choose a default, and revoke an installation. A native client redeems the challenge once at `/callbacks/devices/pair` using a bearer pairing secret and validated registration metadata. It receives a distinct device credential that can authenticate `/api/devices/self`, never owner sessions or connector grants. Only credential hashes are stored. Names may repeat; IDs remain distinct, and replacements receive neither a default assignment nor permission grants. The native pairing screen and persistent connection transport are separate from this registry API.

## Authorization

Owner-managed authorization rules live under `/api/owner/permissions`. Known, available resources without a rule require confirmation; unknown capabilities, unavailable grants and revoked devices are denied. Calendar overrides cannot bypass an account-wide deny. Permission changes increment an owner policy revision, and evaluation snapshots also bind the target, operation and resource revision. Dispatch must re-evaluate the saved snapshot and separately validate the exact action approval; a preview result is not an execution credential. Policy evaluation is the same for scheduled and user-triggered work. Rule editing is not exposed to device credentials or model tools.

Computer permissions are not a filesystem sandbox: unrestricted commands, file writes and desktop input can have broader effects than their direct operation names suggest. In particular, allowing shell execution does not preserve a folder-only restriction on another file tool. The policy response marks these broad capabilities for the management interface. Provider permissions and current calendar access must still be checked by connected-app execution adapters.

## Connected-app targets

Connected-app target resolution uses stable connection and calendar IDs, with independent defaults for reads, drafts, sends, modifications, and calendar writes. Owner-only `/api/owner/connection-targets` stores labels and defaults with revision checks. Tasks bind each operation to one target per task revision; changing it requires steering the task. Multi-account searches label each result with its source and never set a sender default. The resolver rechecks credentials, policy, selected calendars, and provider access roles before returning a target. Executors must revalidate target snapshots and action approvals immediately before effects; target selection does not itself grant permission or send anything.

## Gmail reads

The Gmail reader provides typed search, message, thread, and attachment operations for the trusted backend. Search returns at most 100 references per page; message text is capped at 64,000 characters, threads return at most 20 decoded messages with remaining IDs, and responses are capped at 40 MiB. Attachment bodies are capped at 25 MiB and decoded from Gmail's JSON/base64url representation before being exposed as a chunked stream. Attachment filenames are untrusted display metadata, never filesystem paths. Account and read permission checks run before provider access, and `ask` requires the separate approval flow rather than granting access. These adapters do not expose an unauthenticated HTTP endpoint or read mail on startup; CLI dispatch and artifact persistence are separate integrations.

## Source layout

| Directory            | Responsibility                                               |
| -------------------- | ------------------------------------------------------------ |
| `apps/web`           | React management interface, built with Vite                  |
| `apps/server`        | Protected application entrypoint                             |
| `apps/workspace`     | Isolated computer execution entrypoint                       |
| `apps/cli`           | The `winston` command entrypoint                             |
| `apps/desktop-macos` | Reserved for the native Swift proxy                          |
| `packages/config`    | Exported TypeScript compiler configurations                  |
| `packages/testing`   | Deterministic fixtures and disposable database tests         |
| `packages/ui`        | Winston components, Lucide icons, and shared Tailwind tokens |

The neutral compiler configuration exposes no ambient runtime globals. Bun and browser entrypoints opt into their own environment. Every workspace declares its dependencies explicitly; Bun uses isolated installs. Bun entrypoints use `skipLibCheck` because the pinned Bun declarations contain upstream declaration errors; strict checking of application source remains enabled. Neutral and web configurations retain declaration checking. See [Bun’s TypeScript guidance](https://bun.sh/docs/typescript-6). Shared configurations are consumed through package exports, not cross-package relative paths or aliases.

Domain, application, contracts, and protected browser modules are added as their implementation begins. `packages/adapters` contains the Postgres adapter. Import-boundary linting, formatting, local Git hooks, and GitHub quality checks are configured. Deployment remains a separate upcoming change.

Web pages consume Winston components from `@winston/ui`, which composes Base UI behavior with Tailwind tokens and Lucide icons. Import `@winston/ui/styles.css` after Tailwind and include the UI package source in Tailwind's source scan. Keep shared interaction and styling changes in the UI package so each page gets the same keyboard, focus, and responsive behavior. Searchable selects place their search input in the popup. Shared transitions respect reduced-motion preferences, and sidebar hover, selection, and keyboard focus use distinct tokens.

The development review starts at `/__dev/design`. Enter Components (`/__dev/design/components`) or Pages & states (`/__dev/design/pages`) to switch the sidebar into that area's sub-tabs. Component tabs select distinct previews using the `section` query parameter. Page reviews use `page`, `state`, and `viewport` query parameters, with desktop/mobile iframe viewports, resettable interactions, and copyable feedback links. The registry in `apps/web/src/dev/review-registry.tsx` currently contains the actual component foundation, including navigation; product pages are registered as they are implemented. Component specimens are not substitutes for page coverage.

Register the same view component used by the product, supplied with deterministic data and local action adapters. Keep production data fetching outside view components. Fixture frames disallow HTTP connections, forms, nested frames, and top-level navigation; only the local Vite hot-reload WebSocket is permitted. This guards against accidental service calls, not hostile fixture code. Reset remounts the whole iframe; fixtures must not persist data. Unknown previews fail closed. Development imports are gated by `import.meta.env.DEV`, and the build rejects any review module included in production JavaScript.

The desktop sidebar can be resized by dragging its edge or using the focused separator's arrow keys, Home, and End. Its minimum width is 270px, matching the measured Notion sidebar; the maximum preserves room for content. The resize affordance is a neutral 2px divider on hover, keyboard focus, and drag. The width is stored locally as `winston.sidebar.width`, with graceful fallback when storage is unavailable. Shared controls accept `size="sm" | "md" | "lg"` for fixed 28/32/36px heights, defaulting to medium. Icon-only buttons use `iconOnly` and an accessible label; their width always matches their height.

## Quality checks

```sh
mise exec -- bun run format
mise exec -- bun run format:check
mise exec -- bun run lint
mise exec -- bun run lint:fix
mise exec -- bun run test:tooling
mise exec -- bun run check
```

Prettier owns layout with LF line endings and one source line per Markdown paragraph (`proseWrap: "never"`). EditorConfig supplies editor defaults; Git attributes normalize text line endings. The text check also covers files such as TOML that Prettier does not format. Formatting respects `.gitignore` and `.git/info/exclude`; Prettier skips the unsupported Bun lockfile format.

`sort-package-json` orders fields, scripts, and dependencies in the root and workspace manifests before Prettier runs. `format:check` checks that ordering without changing files. Manifest paths are limited to the root, `apps/*`, and `packages/*` to avoid dependencies and generated output.

ESLint uses typed strict rules for promises and unsafe values, React hooks/accessibility rules, and explicit package dependency directions. Cross-package source imports must use package exports. Domain code cannot import runtime or third-party modules; application code depends only on domain. Web code cannot import server adapters or Node built-ins. Tool configuration uses its own Node environment. New packages must match the architecture map and provide a TypeScript configuration before typed linting passes.

Tailwind class strings in the web app and shared UI use `eslint-plugin-better-tailwindcss` with its correctness preset, duplicate checks, deprecated-class checks, and canonical-class checks. The plugin reads the web app's Tailwind 4 CSS entry point, including shared theme tokens. Unknown classes, conflicting utilities, and dynamically constructed class names fail the normal lint gate. Reusable class strings and variant maps use names ending in `Classes` so they receive the same checks as JSX. Canonicalization uses the default 16px root font size to prefer equivalent spacing utilities and shorthand, with logical-to-physical conversion disabled to preserve directional behavior. Revisit that setting if the root font size changes. ESLint owns canonical suggestions; the duplicate Tailwind IntelliSense diagnostic is disabled in workspace settings. Prettier retains formatting ownership; class sorting, wrapping, forced logical properties, and class restrictions are not enforced. Arbitrary values remain available when no canonical equivalent exists. These checks cover source class strings; the application build validates CSS directives and `@apply` usage.

Keep component layout, sizing, interaction states, and transitions in Tailwind utilities alongside the component. Shared CSS contains theme tokens and base defaults, not a parallel collection of component selectors. Extract reusable components first; small shared utility strings are appropriate for identical styling across different Base UI primitives. Use complete static class names in variant maps and `motion-reduce` variants for animations.

TypeScript 6.0.3 and ESLint 9.39.5 are intentionally pinned to the support ranges of typescript-eslint and the accessibility plugin. Upgrade the compiler and lint toolchain together after checking their peer support; do not suppress unsupported-version warnings. Vite's config is checked against its separate Node tsconfig while application files use TypeScript project service.

`test:tooling` exercises the real configuration with allowed and forbidden examples. `check` runs formatting/text checks, linting, typechecking, and all implemented test suites. Pre-commit runs `check` and `build`; CI will use the same commands.

## Database

The database adapter uses Drizzle 0.45.2 and the already validated `pg` 8.23.0 driver. Application traffic uses a bounded pool with connection recycling; migrations use a dedicated direct connection and a session advisory lock. With Fly Managed Postgres, use the pooled URL for application traffic and `DIRECT_DATABASE_URL` for migrations and session listeners. No named prepared statements or automatic transaction retries are used. An interrupted commit can have an unknown outcome; callers must reconcile using their operation IDs rather than replaying external actions.

Run `bun run db:migrate` with `DIRECT_DATABASE_URL` set for the intended environment. Keep `packages/adapters/migrations` beside the adapter when packaging releases. SQL migrations and the Drizzle journal are append-only; never edit an applied file. Changes to typed schema definitions require a new reviewed SQL migration and journal entry. The migrator checks the applied prefix before advancing and verifies the final schema. Call `assertCompatible()` before marking a database-backed service ready; pending, newer, or altered migration history fails this check. Roll forward with a new migration instead of shipping down migrations.

Repositories are bound to an explicit owner ID for each transaction. The initial owner repository cannot query a different owner through its public methods. This is application scoping, not a substitute for authentication or a database role boundary: callers must supply an authenticated owner identity. Add repositories to the transaction scope as their domain tickets are implemented, and keep model/provider calls outside SQL transactions.

Drizzle's published declaration files currently fail strict library checking, including unused database drivers ([upstream issue](https://github.com/drizzle-team/drizzle-orm/issues/5187)). The adapters, server, and integration-test workspaces that consume those declarations use `skipLibCheck`; our source retains strict typing and exact optional properties. Revisit this exception when upgrading Drizzle. Real PostgreSQL tests cover schema upgrades, migration serialization/history checks, owner scoping, rollback, idle-connection recovery, and authentication with signed provider fixtures. Actual Fly connection and failover validation belongs to infrastructure deployment.

## Testing

```sh
mise exec -- bun run test:unit
mise exec -- bun run test:integration
mise exec -- bun run test
```

Unit tests use Bun's test runner. `@winston/testing` exports a controllable clock, repeatable IDs, and scripted async adapters for model, tool, and provider scenarios. Scripted responses never access a provider and reject unexpected calls; fixtures contain synthetic data only. Keep this package in development dependencies and use it from tests, not production code. Architecture linting rejects production imports of it.

Integration tests require a running local Docker-compatible runtime. On macOS, Colima works: start an installed runtime with `colima start`. The test command reads the active Docker context and rejects remote Docker endpoints. It sets the socket configuration only for the test process, so no shell configuration is required.

Queue integration tests use pg-boss with its PostgreSQL driver under Bun. They verify atomic domain/outbox/job writes, retries, delayed jobs, cancellation, persisted schedules, recovery after killing a worker process, and LISTEN resubscription after terminating a database session. Test-only recovery intervals are shortened to keep the suite bounded. Durable redelivery does not guarantee exactly-once external side effects; application actions still need idempotency and reconciliation. Recurring schedule execution and production failover are verified with their application integrations.

`@winston/testing/postgres` creates a fresh PostgreSQL 17 container from a pinned image for each callback. It generates credentials, connects only to the container's local port, and removes the container and volumes even when the callback throws. It never accepts a database URL from the caller. The integration command deliberately supplies an unusable `DATABASE_URL` to verify that ambient database credentials are ignored. Keep Testcontainers' cleanup sidecar enabled so interrupted processes also have cleanup coverage. Initial runs download container images; later runs reuse the images, never database state.

`test` runs tooling, unit, PostgreSQL integration, and browser suites without Google, OpenRouter, or other production credentials. A stopped container runtime is a failure, not a skipped integration test. Native suites will be added with their application implementation. Deterministic adapters do not replace real-provider smoke checks: OAuth grants and refresh, model streaming/tool calls, cloud browser takeover, and macOS permissions must each be verified against their real services or operating system before those integrations are considered complete.

Run `bun run test:browser:install` once after installing dependencies, and again after upgrading Playwright. Chromium is stored in this project's `node_modules/.cache/ms-playwright`, without changing your normal browser. `bun run test:browser` starts its own Vite server on `127.0.0.1:4175` and checks real controls, keyboard selection, dialog focus, validation, and mobile navigation. That port must be free. Browser checks run in the full local gate and CI; failures retain traces under ignored `test-results/`.

### Live model checks

Run `mise exec -- bun run test:models /absolute/path/to/synthetic.wav` from the repository root with the development key in `.env.local`. The WAV fixture must say “Remind me to call Alex tomorrow” and be smaller than 1 MB. Use synthetic audio only: this command sends it to OpenRouter and prints its transcript. The suite makes bounded, paid requests with no automatic retries, checks the live model catalog, and exercises streaming, corrected user messages, structured account/device clarification, a synthetic computer tool, cancellation, and transcription. It reports observed timing without enforcing a latency threshold.

These opt-in checks are excluded from `test`, hooks, and CI. Ordinary unit tests exercise the actual SDK against synthetic HTTP responses, including provider errors and stale-response suppression, without network access. The revision fixture demonstrates the publication guard; durable coordination and Telegram delivery still require their production implementation.

## Telegram development

Create a dedicated development bot with the official BotFather and put its `TELEGRAM_BOT_TOKEN` in `.env.local`. Set a separate random `TELEGRAM_WEBHOOK_SECRET` of 32–256 URL-safe characters. The API verifies the bot identity at startup. Secrets remain server-side; Telegram transport errors never include the credential-bearing request URL.

Run `bun run dev:telegram` alongside the API and web app for local long polling. Use one poller per development bot and no configured webhook. Polling acknowledges each update only after the shared ingress handler commits it; restarting may redeliver updates, which the database deduplicates. Polling exits safely on transport errors instead of altering a webhook or silently dropping pending updates. Production uses `POST /callbacks/telegram` with Telegram's secret header and a public HTTPS endpoint; local polling refuses `NODE_ENV=production`.

On the signed-in page, choose Connect Telegram, open the generated link, press Start in Telegram, and return to confirm the displayed account. Challenges expire after five minutes, store only a secret hash, and require confirmation in the initiating authenticated web session. Numeric sender/private-chat IDs determine authority; names and usernames do not. Disconnect invalidates pending challenges and future ingress. Re-pairing replaces the old identity, and database uniqueness prevents another owner from taking its binding.

Authorized updates retain the original provider payload and first server receipt timestamp with its timezone snapshot. An outbox event is written in the same transaction. This integration receives messages; conversation execution, outgoing replies and file staging are separate consumers. The dev review includes disconnected, waiting, confirmation, connected, loading and error states with no live side effects.

## Transactional events

Owner transactions expose `events.publish` alongside domain repositories. An event ID is derived from the owner, event type and caller's stable idempotency key. Reusing that key with different payload or destinations fails; exact retries retain the original record. Events and per-destination outbox records commit with the caller's state changes. A later worker can discover pending work even if the publisher stopped before dispatch.

`dispatchNext` processes one owner-scoped destination delivery. PostgreSQL row locks exclude competing claims; a random lease token fences acknowledgements after expiry. Claims expire after 60 seconds, delivery waits are bounded to 45 seconds, and failures retain a safe code with exponential backoff capped at five minutes. Worker hosts must poll continuously and pass their shutdown signal; this adapter does not start a background process. Delivery callbacks must honor cancellation and use event IDs for downstream idempotency because an expired or interrupted request can still have reached its destination.

`events.consume` records its receipt and scoped handler writes in a savepoint within the same transaction, so failed handlers roll back even when their caller catches the exception. Duplicate receipts skip the handler. This guarantee applies to database writes on that transaction, not arbitrary HTTP calls: external effects require their own idempotency or reconciliation. `events.status` exposes attempts, next availability, delivery time and failure state without storing raw transport errors.

## Message envelopes

`@winston/contracts/messages` defines versioned user-message and autonomous-event records and their canonical XML serializers. Ingress creates and persists a user record once with its first server receipt time, owner timezone snapshot, provider timestamps, stable message/event IDs, and unchanged original text. Serialization uses that stored instant and offset, never the current clock or owner profile. Batch context must preserve each original envelope. Provider edits should be recorded separately from the original receipt.

Model-facing user content is escaped inside `user_content`; application metadata appears in `system_event`, including one `sent_at`. Transcriptions carry machine provenance, and only staged attachments include paths, artifact/workspace IDs, checksums, and verification times. The scoped staging service must verify those facts before constructing metadata: schema validation cannot prove a file exists or authorize access. XML labels likewise grant no system-role authority or permissions. Consumers must use authenticated, owner-scoped structured records, never parse user-authored XML into trusted events. Invalid XML control characters are rejected rather than silently changing stored content.

`acceptMessageRevision` preserves the immutable receipt, accepts exact retries, and rejects conflicting, stale, or skipped revisions. Persistence must enforce the same revision comparison atomically. These contracts do not yet ingest Telegram updates, stage files, or persist message revisions; those adapters consume this shared boundary.

## Git hooks

Lefthook is a project dependency. Bun trusts its installation script to install hooks in this checkout; `bun run hooks:install` explicitly installs or repairs them. Run Git with the pinned runtimes available on PATH, for example `mise exec -- git commit`. No global hook configuration is changed.

Pre-commit checks package ordering, formatting, linting, types, tests, and application builds. Checks never auto-fix or stage files. Stage the intended changes and stash any remaining edits or untracked files before committing: the hook rejects an unstaged or partially staged working tree so a passing result describes the files being committed. Ignored local files and build output do not block commits. To fix formatting or lint failures, run `bun run format` or `bun run lint:fix`, review the changes, and stage them yourself.

Commit messages follow Conventional Commits:

```text
chore(hooks): enforce local quality and commit conventions
```

The commit-msg hook validates the message format. Run `bun run commitlint --edit <message-file>` to check a draft without creating a commit. There is no additional pre-push gate; the full quality gate already runs before committing.

Commit body paragraphs may remain on one source line; the conventional header limit still applies. `bun run check:commits` validates existing history locally. In GitHub Actions it reads the event's commit range, including every commit in a multi-commit push or pull request. Initial pushes and manual runs check the entire reachable history.

## GitHub checks

GitHub Actions repeats the local quality gate on pull requests and pushes to `main`: frozen dependency installation, Conventional Commit validation, `bun run check`, and `bun run build`. It installs the runtimes from `mise.toml` and runs real disposable PostgreSQL tests on the hosted runner's Docker engine. Actions are pinned to immutable revisions, checkout credentials are not persisted, and the workflow has read-only repository permissions. Quality and protocol jobs do not receive deployment or provider secrets.

Successful pushes to this repository's `main` branch deploy only after both `Quality` and `Swift device protocol` succeed. Pull requests and manual quality runs cannot deploy. The GitHub `production` environment restricts deployment to `main` and holds only an app-scoped `FLY_API_TOKEN`; runtime provider credentials stay in Fly secrets. The action and Fly CLI versions are pinned. Image labels include the verified commit, run ID and attempt; Fly records the resulting immutable image digest for each release.

Main runs and production deployments are serialized without canceling an active migration when another push arrives. Pending runs can be superseded by GitHub concurrency; every commit's checks still run locally before commit. Failed checks skip deployment, migration failure aborts rollout, and readiness failure fails the deploy job. The final step also checks the public readiness endpoint.

To roll back application code, deploy a previously verified image by digest with `fly deploy --image registry.fly.io/winston-628@sha256:<digest> --skip-release-command --ha=false` only after confirming that its schema expectations accept the current database. Rollback does not undo migrations. Keep schema changes additive and compatible with running code; otherwise ship a forward fix or use the separately verified database restore procedure. Coordinate a manual rollback with the serialized deployment queue so a queued main push does not immediately replace it. Rotate the app-scoped deployment token before expiry by updating the production environment secret, verifying deployment, and then revoking the old token.
