import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/browser",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run --cwd apps/web dev --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175/__dev/design",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
