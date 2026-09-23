import { readFile } from "node:fs/promises";
import { install, inspectInstallation } from "@gsalgadotoledo/rt-app-installer";
import { host } from "./host.js";
const path = process.argv[2];
if (!path)
  throw new Error(
    "Uso: node rt-app/cli/dist/index.js config.json --confirm NOMBRE. ADMIN_PASSWORD por entorno; perfil AWS/SSO.",
  );
const config = JSON.parse(await readFile(path, "utf8"));
const identity = await inspectInstallation(config);
const modules = JSON.parse(await readFile("modules.json", "utf8")).modules;
const confirmation = process.argv[3] === "--confirm" ? process.argv[4] : "";
await install(
  {
    config,
    modules,
    expectedAccount: identity.account,
    confirmation,
  },
  host,
);
