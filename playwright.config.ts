import { defineConfig, devices } from "@playwright/test";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const port = Number(process.env.E2E_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
  },
  projects: [
    // Scenarios assert macOS wording, but the preset reports Windows.
    { name: "chromium", use: { ...devices["Desktop Chrome"], userAgent: MAC_CHROME } },
    // Repeat representative core journeys and explicit browser risks, not every feature variant.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@webkit\b/ },
  ],
  webServer: {
    // The static production preview avoids HMR reloads when concurrent work edits this checkout.
    command: `npm run design-system:build && npx vite build && npx vite preview --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
