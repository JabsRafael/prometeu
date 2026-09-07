import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", root], { stdio: "inherit" });
await build({
  root, configFile: false, publicDir: false,
  build: {
    outDir: "dist", emptyOutDir: false,
    lib: { entry: "src/browser.ts", formats: ["es"], fileName: () => "browser.js" },
  },
});
