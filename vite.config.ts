import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    // A webview do Tauri é moderna; sem isto o esbuild recusa o `await` de
    // topo de módulo no bootstrap, que o dev aceita sem reclamar.
    target: "esnext",
    minify: "esbuild",
  },
});
