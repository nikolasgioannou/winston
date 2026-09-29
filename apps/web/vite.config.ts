import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site (docs/design.md §9). Port 3002 matches the Google OAuth dev
// client's redirect URI (docs/runbooks/google-cloud.md).
export default defineConfig({
  server: { port: 3002, strictPort: true },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
});
