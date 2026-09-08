import { defineConfig } from "vite";

/// Browser bundle of the collaboration core for prometeu-cloud. Fixed file names let the Rails layout
/// reference them; Propshaft adds the digest. Vendor with `bin/mobile` in prometeu-cloud.
export default defineConfig({
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    rollupOptions: {
      input: "src/mobile/main.ts",
      output: { entryFileNames: "mobile.js", assetFileNames: "mobile.[ext]", inlineDynamicImports: true },
    },
  },
});
