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

// The site (docs/design.md §9). Port 3002 matches the Google OAuth dev
// client's redirect URI (docs/runbooks/google-cloud.md).
export default defineConfig(({ command }) => {
  const build = command === "build";
  return {
    server: { port: 3002, strictPort: true },
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
