import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {defineConfig} from "vite";
import {viteConfiguration} from "@gsalgadotoledo/rt-app-config";
export default defineConfig({
  ...viteConfiguration(process.env,'admin'),
  plugins: [{ name: "rt-app-project-admin", resolveId(id) {
    if (id !== "virtual:rt-app-admin") return;
    const registry = resolve(process.env.RT_APP_PROJECT_ROOT ?? "../..", "packages/admin.js");
    return existsSync(registry) ? registry : "\0empty-rt-app-admin";
  }, load(id) { if (id === "\0empty-rt-app-admin") return "export default {};"; } }],
  build:{outDir:"dist/web",emptyOutDir:true},
});
