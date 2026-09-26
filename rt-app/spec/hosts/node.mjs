// Contract host for the TypeScript/JavaScript implementations (reference target).
// Every hosts/node/*.mjs file exports `subjects`; add a file per module group.
import { readdir } from "node:fs/promises";
import { runHost } from "@gsalgadotoledo/rt-app-conformance";

const folder = new URL("./node/", import.meta.url);
const subjects = {};
for (const file of (await readdir(folder)).filter((f) => f.endsWith(".mjs")).sort()) {
  for (const [name, factory] of Object.entries((await import(new URL(file, folder).href)).subjects)) {
    if (subjects[name]) throw new Error(`Duplicate subject ${name} in ${file}`);
    subjects[name] = factory;
  }
}
await runHost({ language: "javascript", subjects });
