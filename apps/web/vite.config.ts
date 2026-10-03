import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Production builds leave out the dev design view (src/routes/dev/**,
// docs/design.md §9). They generate their route tree without it into a
// separate, gitignored file, so the committed tree (which keeps /dev for
// type checking) never changes, and point the router's import at that
// file. The alias isn't documented by TanStack, so `verify:build` (run by
// `bun run check`) fails if a build ever includes the dev routes again.
const prodRouteTree = fileURLToPath(
  new URL("src/routeTree.prod.gen.ts", import.meta.url),
);

// The site (docs/design.md §9), on WEB_PUBLIC_URL's port: 3002, which matches
// the Google OAuth dev client's redirect URI (docs/runbooks/google-cloud.md),
// or a worktree's own (docs/local-dev.md).
const port = Number(
  new URL(process.env.WEB_PUBLIC_URL ?? "http://localhost:3002").port,
);

export default defineConfig(({ command }) => {
  const build = command === "build";
  return {
    server: { port, strictPort: true },
    plugins: [
      tanstackStart(
        build
          ? {
              router: {
                routeFileIgnorePattern: "^dev$",
                generatedRouteTree: "routeTree.prod.gen.ts",
              },
            }
          : {},
      ),
      viteReact(),
      tailwindcss(),
    ],
    ...(build
      ? {
          resolve: {
            alias: [
              { find: /^\.\/routeTree\.gen$/, replacement: prodRouteTree },
            ],
          },
        }
      : {}),
  };
});
