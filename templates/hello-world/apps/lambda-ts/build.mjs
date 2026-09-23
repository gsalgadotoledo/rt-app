import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("./",import.meta.url));
mkdirSync(directory + "bundle", { recursive: true });
await build({
  absWorkingDir: directory,
  entryPoints: ["src/index.ts"],
  outfile: "bundle/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
writeFileSync(
  directory + "bundle/package.json",
  JSON.stringify({ type: "module" }),
);
console.log("Lambda bundle ready: apps/lambda-ts/bundle/index.mjs");
