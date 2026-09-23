import { install } from "@gsalgadotoledo/rt-app-installer";
import { host } from "./host.js";
let body = "";
for await (const chunk of process.stdin) {
  body += chunk;
  if (body.length > 32768) throw new Error("Input too large");
}
try {
  const result = await install(JSON.parse(body), host);
  process.stdout.write(JSON.stringify({ result }) + "\n");
} catch (e: any) {
  process.stdout.write(
    JSON.stringify({ error: e.name === "Error" ? e.message : e.name }) + "\n",
  );
  process.exitCode = 1;
}
