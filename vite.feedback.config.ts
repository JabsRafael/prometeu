import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "scope-feedback-tokens",
    generateBundle(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type === "asset" && asset.fileName.endsWith(".css") && typeof asset.source === "string") {
          asset.source = asset.source.replaceAll(":root", ".ui-feedback");
        }
      }
    },
  }],
  build: {
    outDir: "dist-feedback",
    lib: { entry: "src/feedback-web.ts", formats: ["es"], fileName: () => "feedback.js", cssFileName: "feedback" },
  },
});
