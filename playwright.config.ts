import { defineConfig, devices } from "@playwright/test";

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
    locale: "pt-BR",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // O app de verdade roda no WebKit. O que é gesto do motor — o canto que
    // estica, o arraste — precisa rodar nele também. A navegação pelos agentes
    // na barra lateral cobre foco, seleção e recolhimento no mesmo motor.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /a mesa|a barra lateral/ },
  ],
  webServer: {
    // O preview é estático: além de exercitar o bundle de produção, evita um
    // reload de HMR no meio do teste quando outra tarefa toca o worktree.
    command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
