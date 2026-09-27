// Reference API for http contracts: the TypeScript framework with every module, an in-memory
// store and local admin access (owner endpoints under /admin/app, no login).
import { createServer } from "node:http";
import { clientIp } from "@gsalgadotoledo/rt-app-contracts";
import { randomBytes } from "node:crypto";
import { createApplication } from "@gsalgadotoledo/rt-app-framework";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { MemoryQueue } from "@gsalgadotoledo/rt-app-queue";
import { localChoiceProvider } from "./node/choice.mjs";

const app = createApplication({
  store: new MemoryStore(),
  localAdminAccess: true,
  mailer: new LocalMailbox(),
  secret: randomBytes(48).toString("hex"),
  // Choice is opt-in (no provider, no endpoint); the local provider is deterministic, see choice-api.
  choiceProvider: localChoiceProvider(),
  observerOutputs: [],
  queueAdapter: new MemoryQueue(),
});
await app.migrate();

const reply = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
};
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > app.bodyLimit(req.method ?? "GET", url.pathname)) return reply(res, 413, { error: "Request body too large" });
  }
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
    if (!body || Array.isArray(body) || typeof body !== "object") throw 0;
  } catch {
    return reply(res, 400, { error: "Invalid JSON" });
  }
  const result = await app.handle({ method: req.method ?? "GET", path: url.pathname, body, rawBody: raw, query: Object.fromEntries(url.searchParams), headers: req.headers, ip: clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]) });
  reply(res, result.status, result.body);
}).listen(Number(process.env.PORT ?? 4010), "127.0.0.1", () => console.log(`Reference API: http://127.0.0.1:${process.env.PORT ?? 4010}`));
