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

`dev` starts the web app on `127.0.0.1:5173`. Visit `/__dev/design` to review shared components and page states without external services; review modules are excluded from production builds. The root page supports Google sign-in and sign-out. Product management pages follow separately. `dev:server` starts the API on `127.0.0.1:3001` and reads the root `.env.local`. Workspace and CLI entrypoints still build as empty modules. Automated checks use synthetic credentials and disposable databases.

The API exposes `/health/live` for process liveness and `/health/ready` for startup and dependency readiness. Startup requires a compatible migrated database and complete authentication configuration. Callback, owner, device, and task route groups have separate authenticators and reject access by default. Owner routes validate database sessions and the verified email allowlist on every request; mutations also require the configured web origin. Other authority implementations arrive separately. Request errors use stable codes and server-generated correlation IDs. Request logs contain only correlation ID, status, and duration, excluding request content and raw exceptions. SIGINT/SIGTERM stop new connections and drain active requests, forcing closure after the configured timeout.

## Google sign-in

Set `DATABASE_URL`, `DIRECT_DATABASE_URL`, `BETTER_AUTH_URL`, `WEB_ORIGIN`, `BETTER_AUTH_SECRET` (at least 32 random characters), `OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in the root `.env.local`. Use a local database and a development Google Web application client. Register `http://127.0.0.1:3001/api/auth/callback/google` as its redirect URI. Run `bun run db:migrate`, then `bun run dev:server` and `bun run dev` in separate terminals. Open `http://127.0.0.1:5173`; Vite proxies `/api` to the local API. Use `127.0.0.1` consistently for local cookies and redirects. Production requires HTTPS origins, a separate OAuth client, and same-origin API routing.

Better Auth requests only Google identity scopes. The server fixes the provider, scopes, and return destination, rejects unverified or non-allowlisted identities on new and returning logins, and disables account linking. Sessions use HTTP-only cookies, secure cookies on HTTPS, database-backed OAuth state, and no cookie session cache. Stored login tokens are encrypted with the auth secret. Gmail/Calendar credentials use separate `GOOGLE_CONNECTOR_CLIENT_ID` and `GOOGLE_CONNECTOR_CLIENT_SECRET` variables; their callback is reserved for the upcoming connector implementation and is not active yet.

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

GitHub Actions repeats the local quality gate on pull requests and pushes to `main`: frozen dependency installation, Conventional Commit validation, `bun run check`, and `bun run build`. It installs the runtimes from `mise.toml` and runs real disposable PostgreSQL tests on the hosted runner's Docker engine. Actions are pinned to immutable revisions, checkout credentials are not persisted, and the workflow has read-only repository permissions with no deployment or provider secrets.

The `Quality` job is the gate that future deployment jobs must depend on. This workflow does not deploy. Any later deployment must be restricted to trusted pushes to `main` and run only after this gate succeeds.
