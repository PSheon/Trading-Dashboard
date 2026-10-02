import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3109);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PLAYWRIGHT_PORT");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./e2e",
  // Runs after the web server is up: compiles every route once.
  globalSetup: "./e2e/global-setup.ts",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30000,
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "1",
    timeout: 120000,
    env: { NODE_OPTIONS: `--max-old-space-size=${process.env.PLAYWRIGHT_SERVER_HEAP_MB ?? 4096}`, NEXT_TEST_MODE: "1", NEXT_PUBLIC_API_FIXTURES: "1", NEXT_PUBLIC_PRIVY_APP_ID: "", NEXT_API_URL: "" },
  },
});
