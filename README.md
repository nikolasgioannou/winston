# Winston

Winston is a personal executive assistant that lives in Telegram. You chat with him, and he also acts on his own: texting before meetings, flagging important email, following up on things. He has his own computer (a VM) and is built to be excellent at using a web browser.

## Setup

Runtimes are pinned in `mise.toml`.

```bash
mise install
bun install
```

`bun install` also installs the git hooks (lefthook). Every commit runs formatting, linting, type checks and tests, and commit messages must be a single Conventional Commits subject line. To run the checks yourself:

```bash
bunx lefthook run pre-commit --all-files
```

## Docs

- [Product](docs/product.md): what Winston is and why
- [Design](docs/design.md): how it works, decisions and specifications
- [Plan](docs/plan.md): the build order; tickets live in `.moth/`
