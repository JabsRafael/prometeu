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
    // Cover desktop WebKit gestures, Git review, encrypted collaboration and asynchronous editing.
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /comentário fica|segurança do compartilhamento|organizações no desktop|controle remoto no rodapé|rodapé da conversa|catálogo pessoal|a mesa|a barra lateral|design system|comando reutilizável|perfil por projeto|Code review|arquivo solto|arraste de arquivo|Git|a tela de Mudanças|file saving|finishing a save|cleanup keeps|legacy import/ },
  ],
  webServer: {
    // The static production preview avoids HMR reloads when concurrent work edits this checkout.
    command: `npm run design-system:build && npx vite build && npx vite preview --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
