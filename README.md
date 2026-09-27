# Winston

Winston is a personal executive assistant that lives in Telegram. You chat with him, and he also acts on his own: texting before meetings, flagging important email, following up on things. He has his own computer (a VM) and is built to be excellent at using a web browser.

## Setup

You need [mise](https://mise.jdx.dev/getting-started.html). Then run:

```bash
./scripts/setup.sh
```

It's safe to re-run at any time, and a re-run doubles as a health check.

Every commit runs the same checks as CI (formatting, linting, type checks and tests), and commit messages must be a single Conventional Commits subject line. To run the checks yourself:

```bash
bun run check
```

## Docs

- [Product](docs/product.md): what Winston is and why
- [Design](docs/design.md): how it works, decisions and specifications
- [Plan](docs/plan.md): the build order; tickets live in `.moth/`
