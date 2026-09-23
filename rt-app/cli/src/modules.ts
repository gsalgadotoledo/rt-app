import { readFile, writeFile } from "node:fs/promises";
import { coreModules, validateModules } from "@gsalgadotoledo/rt-app-installer";
const [action = "list", name] = process.argv.slice(2);
const config = JSON.parse(await readFile("modules.json", "utf8"));
if (action === "list") console.log(config.modules.join("\n"));
else if (["enable", "disable"].includes(action) && name === "tasks") {
  config.modules = [...config.modules.filter((id: string) => id !== "tasks"), ...(action === "enable" ? ["tasks"] : [])];
  validateModules(config.modules, (config.generatedCrud ?? []).map((entry: {name:string})=>entry.name));
  await writeFile("modules.json", JSON.stringify(config, null, 2) + "\n");
  console.log(
    "Modules configured. Restart local apps or redeploy to apply the changes.",
  );
} else
  throw new Error(
    "Usage: npm run cli -- list | enable tasks | disable tasks. Use rta create crud to generate application modules.",
  );
