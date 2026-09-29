---
id: "47c24f"
title: Recommend VS Code extensions and settings for the repo's tools
status: done
priority: none
labels:
  - m3
  - tooling
created_at: 2026-09-29T00:47:28.659Z
updated_at: 2026-09-29T00:49:53.963Z
blocked_by:
  - "6b393b"
---

Contributors who open the repo in VS Code should get the right extensions and settings for the tools we already use, without setting anything up by hand. Requested by the user on 2026-09-28.

Research first, based on what the repo uses today (check each extension's current id, settings and how it behaves with our versions):
- TypeScript: use the workspace TypeScript (`typescript.tsdk`), not VS Code's bundled one.
- ESLint 10 flat config (`eslint.config.ts`) with typed linting, including TSX in `apps/web`.
- Prettier as the default formatter, format on save, with our plugins (`prettier-plugin-packagejson`, `prettier-plugin-tailwindcss`) and `.prettierignore`.
- Tailwind CSS IntelliSense for Tailwind v4 (CSS-first, the stylesheet at `apps/web/src/styles/app.css`), including class completion inside `cn`/`clsx`/`cva`.
- Bun (runtime and test runner), Packer HCL (`image/`), Markdown for docs and Moth tickets, `.env` files, YAML (lefthook, moth), and anything else the repo already relies on.
- Files to hide or exclude from search and watchers (generated route tree, `node_modules`, build output, `.packer/`, `.data/`).

Deliver `.vscode/extensions.json` (recommendations) and `.vscode/settings.json`, committed. Settings stay project-level only; nothing touches a contributor's global config. Keep it minimal: only what our tools need.

Add a rule to `AGENTS.md` next to "Keep `scripts/setup.sh` complete": when a change adds or changes a tool, update `.vscode/` in the same commit if it's relevant. Mention the editor setup in `docs/local-dev.md`.

## Outcome

- `.vscode/extensions.json` recommends ESLint (`dbaeumer.vscode-eslint`, which supports ESLint 10 and `eslint.config.ts` with no settings), Prettier (`esbenp.prettier-vscode`, which uses the repo's Prettier, plugins and `.prettierignore`, and loads `prettier.config.ts` on VS Code's Node 24), Tailwind CSS IntelliSense (`bradlc.vscode-tailwindcss`) and HashiCorp HCL (highlighting for `image/`). Left out: Bun's extension (test panel and debugger, not needed by the tooling), YAML, dotenv and Markdown extensions.
- `.vscode/settings.json`: the workspace TypeScript (`js/ts.tsdk.path` and `js/ts.tsdk.promptToUseWorkspaceVersion`, which current VS Code uses in place of the deprecated `typescript.tsdk` settings), Prettier as default formatter with format on save, ESLint fixes on explicit save, Tailwind v4 pointed at `apps/web/src/styles/app.css` with `cn`/`clsx`/`cva`, and TanStack Router's recommended read-only/watcher/search settings for `routeTree.gen.ts`. Personal preferences stay out.
- `AGENTS.md` gained "Keep the editor setup current"; `docs/local-dev.md` gained an "Editor" section.
