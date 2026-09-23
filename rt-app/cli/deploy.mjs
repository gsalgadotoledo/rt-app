import { readFile, writeFile, mkdir } from "node:fs/promises";
import { publishEnvironment } from "@gsalgadotoledo/rt-app-installer";
import { host } from "./dist/host.js";
const environment = process.env.TF_VAR_environment;
if (!["develop", "stage", "prod"].includes(environment))
  throw new Error("Invalid environment");
const outputs = JSON.parse(await readFile(process.argv[2], "utf8"));
const config = {
  provider: "aws",
  region: process.env.AWS_REGION,
  stack: process.env.TF_VAR_app,
  mailFrom: process.env.TF_VAR_mail_from,
  repository: process.env.GITHUB_REPOSITORY,
};
const result = await publishEnvironment(
  config,
  environment,
  outputs,
  host,
  process.env,
  undefined,
  JSON.parse(await readFile("modules.json", "utf8")).modules,
);
await mkdir(".rt-app", { recursive: true });
await writeFile(".rt-app/release.json", JSON.stringify(result, null, 2) + "\n");
console.log(
  "Published " +
    environment +
    ": " +
    result.adminUrl +
    " | " +
    result.publicUrl +
    (result.ssrUrl ? " | " + result.ssrUrl : ""),
);
