import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  // A porta vem do ambiente porque cada worktree tem a sua: dois `npm run dev`
  // na 1420 é o que impede olhar duas mudanças lado a lado. Continua `strict`
  // — o Tauri precisa saber para onde apontar o `devUrl`, e cair para a porta
  // seguinte em silêncio deixaria a janela num vite que não é o dele.
  server: { port: Number(process.env.PORT ?? 1420), strictPort: true },
  build: {
    // A webview do Tauri é moderna; sem isto o esbuild recusa o `await` de
    // topo de módulo no bootstrap, que o dev aceita sem reclamar.
    target: "esnext",
    minify: "esbuild",
  },
  // Só os testes deste repositório. Os worktrees moram dentro da pasta do
  // clone principal (`~/prometeu/worktrees*/`), e o vitest não lê o
  // `.gitignore`: sem isto ele roda os testes de todo repo que tem worktree
  // aqui — e a release do Prometeu parava num teste do repo dos outros.
  test: { include: ["src/**/*.test.ts", "relay/src/**/*.test.ts"] },
});
