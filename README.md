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

`dev` starts the web app on localhost. It currently renders an empty React root; product screens follow design review. Server, workspace, and CLI entrypoints currently build as empty modules and do not start services or execute commands. No provider credentials or infrastructure are required for these checks.

## Source layout

| Directory            | Responsibility                                       |
| -------------------- | ---------------------------------------------------- |
| `apps/web`           | React management interface, built with Vite          |
| `apps/server`        | Protected application entrypoint                     |
| `apps/workspace`     | Isolated computer execution entrypoint               |
| `apps/cli`           | The `winston` command entrypoint                     |
| `apps/desktop-macos` | Reserved for the native Swift proxy                  |
| `packages/config`    | Exported TypeScript compiler configurations          |
| `packages/testing`   | Deterministic fixtures and disposable database tests |

The neutral compiler configuration exposes no ambient runtime globals. Bun and browser entrypoints opt into their own environment. Every workspace declares its dependencies explicitly; Bun uses isolated installs. Bun entrypoints use `skipLibCheck` because the pinned Bun declarations contain upstream declaration errors; strict checking of application source remains enabled. Neutral and web configurations retain declaration checking. See [Bun’s TypeScript guidance](https://bun.sh/docs/typescript-6). Shared configurations are consumed through package exports, not cross-package relative paths or aliases.

Domain, application, contracts, adapters, UI, and protected browser modules are added as their implementation begins. Import-boundary linting, formatting, and local Git hooks are configured. CI remains a separate upcoming change.

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

TypeScript 6.0.3 and ESLint 9.39.5 are intentionally pinned to the support ranges of typescript-eslint and the accessibility plugin. Upgrade the compiler and lint toolchain together after checking their peer support; do not suppress unsupported-version warnings. Vite's config is checked against its separate Node tsconfig while application files use TypeScript project service.

`test:tooling` exercises the real configuration with allowed and forbidden examples. `check` runs formatting/text checks, linting, typechecking, and all implemented test suites. Pre-commit runs `check` and `build`; CI will use the same commands.

## Testing

```sh
mise exec -- bun run test:unit
mise exec -- bun run test:integration
mise exec -- bun run test
```

Unit tests use Bun's test runner. `@winston/testing` exports a controllable clock, repeatable IDs, and scripted async adapters for model, tool, and provider scenarios. Scripted responses never access a provider and reject unexpected calls; fixtures contain synthetic data only. Keep this package in development dependencies and use it from tests, not production code. Architecture linting rejects production imports of it.

Integration tests require a running local Docker-compatible runtime. On macOS, Colima works: start an installed runtime with `colima start`. The test command reads the active Docker context and rejects remote Docker endpoints. It sets the socket configuration only for the test process, so no shell configuration is required.

`@winston/testing/postgres` creates a fresh PostgreSQL 17 container from a pinned image for each callback. It generates credentials, connects only to the container's local port, and removes the container and volumes even when the callback throws. It never accepts a database URL from the caller. The integration command deliberately supplies an unusable `DATABASE_URL` to verify that ambient database credentials are ignored. Keep Testcontainers' cleanup sidecar enabled so interrupted processes also have cleanup coverage. Initial runs download container images; later runs reuse the images, never database state.

`test` runs tooling, unit, and PostgreSQL integration suites without Google, OpenRouter, or other production credentials. A stopped container runtime is a failure, not a skipped integration test. Browser and native suites will be added with their respective application implementations and exposed separately. Deterministic adapters do not replace real-provider smoke checks: OAuth grants and refresh, model streaming/tool calls, cloud browser takeover, and macOS permissions must each be verified against their real services or operating system before those integrations are considered complete.

## Git hooks

Lefthook is a project dependency. Bun trusts its installation script to install hooks in this checkout; `bun run hooks:install` explicitly installs or repairs them. Run Git with the pinned runtimes available on PATH, for example `mise exec -- git commit`. No global hook configuration is changed.

Pre-commit checks package ordering, formatting, linting, types, tests, and application builds. Checks never auto-fix or stage files. Stage the intended changes and stash any remaining edits or untracked files before committing: the hook rejects an unstaged or partially staged working tree so a passing result describes the files being committed. Ignored local files and build output do not block commits. To fix formatting or lint failures, run `bun run format` or `bun run lint:fix`, review the changes, and stage them yourself.

Commit messages follow Conventional Commits:

```text
chore(hooks): enforce local quality and commit conventions
```

The commit-msg hook validates the message format. Run `bun run commitlint --edit <message-file>` to check a draft without creating a commit. There is no additional pre-push gate; the full quality gate already runs before committing.
