# Winston

A personal sidekick with Telegram as its conversational interface.

## Development

Use the Bun and Node versions pinned in `mise.toml`. With those versions already installed, run commands from this directory:

```sh
mise exec -- bun install --frozen-lockfile
mise exec -- bun run typecheck
mise exec -- bun run build
mise exec -- bun run dev
```

`dev` starts the web app on localhost. It currently renders an empty React root; product screens follow design review. Server, workspace, and CLI entrypoints currently build as empty modules and do not start services or execute commands. No provider credentials or infrastructure are required for these checks.

## Source layout

| Directory | Responsibility |
| --- | --- |
| `apps/web` | React management interface, built with Vite |
| `apps/server` | Protected application entrypoint |
| `apps/workspace` | Isolated computer execution entrypoint |
| `apps/cli` | The `winston` command entrypoint |
| `apps/desktop-macos` | Reserved for the native Swift proxy |
| `packages/config` | Exported TypeScript compiler configurations |

The neutral compiler configuration exposes no ambient runtime globals. Bun and browser entrypoints opt into their own environment. Every workspace declares its dependencies explicitly; Bun uses isolated installs. Bun entrypoints use `skipLibCheck` because the pinned Bun declarations contain upstream declaration errors; strict checking of application source remains enabled. Neutral and web configurations retain declaration checking. See [Bun’s TypeScript guidance](https://bun.sh/docs/typescript-6). Shared configurations are consumed through package exports, not cross-package relative paths or aliases.

Domain, application, contracts, adapters, UI, and protected browser modules are added as their implementation begins. Import-boundary linting, formatting, Lefthook, commitlint, and CI are separate upcoming changes.