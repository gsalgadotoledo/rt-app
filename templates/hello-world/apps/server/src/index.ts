import {publicConfig} from "@gsalgadotoledo/rt-app-config";
import {localSecret} from "./local-secret.js";
import { localSetupStatus } from "./setup.js";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  runtimeSettings,
  createApplication,
  loadProductionApplication,
  createPortableApplication,
  seedDemo,
} from "../../../main.js";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalSmtpMailer } from "@gsalgadotoledo/rt-app-mail-local";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { localDynamo } from "./local-dynamo.js";
import { localPostgres } from "./local-postgres.js";
import { handleDeployRequest } from "@gsalgadotoledo/rt-app-deployments/server";
import { passwordVerifier } from "@gsalgadotoledo/rt-app-myadmin/backend";
import { fileURLToPath } from "node:url";
const { target, mode } = runtimeSettings();
if (!["json", "memory", "dynamodb-local", "postgres", "aws", "portable"].includes(mode))
  throw new Error("Invalid RT_APP_MODE");
// local: this machine only. aws: Lambda/AWS installation. portable: Render, Railway, Fly.io…
const local = target === "local";
if ((mode === "dynamodb-local" || mode === "postgres") && !process.env.DEMO_PASSWORD)
  throw new Error(
    "Set DEMO_PASSWORD explicitly for persistent local demo accounts",
  );
if (local && process.env.NODE_ENV === "production")
  throw new Error("Memory demo is disabled in production");
const mailbox = new LocalMailbox();
const mailTransport = process.env.RT_APP_MAIL_TRANSPORT ?? "memory";
if (!["memory", "smtp"].includes(mailTransport)) throw new Error("Invalid RT_APP_MAIL_TRANSPORT");
const app = local
  ? createApplication({
      store:
        mode === "json" ? new JsonStore(process.env.RT_APP_JSON_FILE ?? ".rt-app/local.json") : mode === "dynamodb-local" ? await localDynamo() : mode === "postgres" ? localPostgres() : new MemoryStore(),
      localAdminAccess: true,
      mailer: mailTransport === "smtp" ? new LocalSmtpMailer({port: Number(process.env.RT_APP_MAIL_SMTP_PORT ?? 1025), capture: mailbox}) : mailbox,
      secret: mode === "json" ? await localSecret(process.env.RT_APP_JSON_FILE ?? ".rt-app/local.json") : mode === "postgres" ? await localSecret(".rt-app/postgres") : randomBytes(48).toString("hex"),
      tasks: process.env.ENABLE_TASKS !== "false",
    })
  : target === "portable"
    ? createPortableApplication()
    : await loadProductionApplication();
if (local) {
  await app.migrate();
  if (mode !== "json" || process.env.DEMO_PASSWORD) {
  const password =
    process.env.DEMO_PASSWORD ?? randomBytes(16).toString("base64url");
  const users = await seedDemo(app, password);
  console.log(
    mode === "memory"
      ? "LOCAL DEMO: in-memory data is lost on restart."
      : `LOCAL DEMO: data persisted in ${mode}; seeding preserves existing passwords.`,
  );
  console.log(
    "Admin: local access without a password. Public users:",
    users.join(", "),
  );
  console.log("Demo password:", password);
  }
  console.log("Local database:", mode);
}
const port = Number(process.env.PORT ?? 4010);
const configuredOrigins = Object.values(publicConfig().urls).flatMap(value => {
  const url = new URL(value);
  return [url.origin, ...(["localhost", "127.0.0.1"].includes(url.hostname) ? ["localhost", "127.0.0.1"].map(host=>`${url.protocol}//${host}:${url.port}`) : [])];
});
const allowedOrigins = new Set([...configuredOrigins, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const allowedHosts = new Set([...allowedOrigins].map(origin=>new URL(origin).host));
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Passwordless administration is loopback-only, including reads (DNS rebinding / cross-origin).
    if (local && (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
      || !allowedHosts.has(req.headers.host ?? "")
      || (req.headers.origin && !allowedOrigins.has(req.headers.origin)))) {
      return reply(403, { error: "Origin not allowed" });
    }
    if (local && url.pathname === "/__dev/setup" && req.method === "GET") {
      if (!allowedHosts.has(req.headers.host ?? "") || (req.headers.origin && !allowedOrigins.has(req.headers.origin)))
        return reply(403, { error: "Origin not allowed" });
      reply(200, await localSetupStatus());
      return;
    }
    // This inbox is exclusively a loopback development tool; absent from Lambda.
    if (local && url.pathname === "/__dev/mailbox" && req.method === "GET") {
      reply(200, mailbox.messages);
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method ?? "GET") &&
      req.headers.origin &&
      !allowedOrigins.has(req.headers.origin)
    ) {
      reply(403, { error: "Origin not allowed" });
      return;
    }
    req.setEncoding("utf8");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > (url.pathname === "/subscriptions/webhook" ? 262144 : 16384)) {
        reply(413, { error: "Request body too large" });
        return;
      }
    }
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
      if (!body || Array.isArray(body) || typeof body !== "object") throw 0;
    } catch {
      reply(400, { error: "Invalid JSON" });
      return;
    }
    // Deployments page of the local admin: provider targets, keys, plan/apply (owner only).
    if (local && url.pathname.startsWith("/__dev/deploy")) {
      const actor = await app.admin.auth.actor(req.headers.authorization);
      if (!actor || actor.role !== "owner") {
        reply(403, { error: "Only the owner can manage deployments" });
        return;
      }
      const result = await handleDeployRequest(
        { method: req.method ?? "GET", path: url.pathname, body, query: Object.fromEntries(url.searchParams) },
        { root: fileURLToPath(new URL("../../../", import.meta.url)), passwordVerifier },
      );
      reply(result.status, result.body);
      return;
    }
    if (local && url.pathname === "/__dev/modules") {
      const actor = await app.admin.auth.actor(req.headers.authorization);
      if (!actor || actor.role !== "owner") {
        reply(403, { error: "Only the owner can configure modules" });
        return;
      }
      const path = new URL("../../../modules.json", import.meta.url);
      const required = ["content", "infra", "users", "auth", "acl"];
      const configuration = JSON.parse(await readFile(path, "utf8"));
      const available = [...required, "tasks", ...(configuration.generatedCrud ?? []).map((entry: {name:string})=>entry.name)];
      if (req.method === "GET") {
        reply(200, {
          ...JSON.parse(await readFile(path, "utf8")),
          required,
          available,
        });
        return;
      }
      if (req.method === "PUT") {
        const modules = (body as any).modules;
        if (
          !Array.isArray(modules) ||
          required.some((id) => !modules.includes(id)) ||
          modules.some((id) => !available.includes(id)) ||
          new Set(modules).size !== modules.length
        ) {
          reply(400, { error: "Invalid module selection" });
          return;
        }
        await writeFile(path, JSON.stringify({ ...configuration, modules }, null, 2) + "\n");
        reply(200, {
          modules,
          message:
            "Configuration saved. Restart the apps or redeploy to apply it.",
        });
        return;
      }
      reply(405, { error: "Method not allowed" });
      return;
    }
    const result = await app.handle({
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      rawBody: raw,
      headers: { authorization: req.headers.authorization, "stripe-signature": typeof req.headers["stripe-signature"]==='string'?req.headers["stripe-signature"]:undefined, "idempotency-key":typeof req.headers["idempotency-key"]==='string'?req.headers["idempotency-key"]:undefined },
      ip: req.socket.remoteAddress ?? "unknown",
    });
    reply(result.status, result.body);
  } catch {
    reply(500, { error: "Internal error" });
  }
});
// Deployed processes accept the platform's proxy; local development stays on loopback.
server.listen(port, local ? "127.0.0.1" : "0.0.0.0", () =>
  console.log(`RT-App API: http://127.0.0.1:${port}`),
);

// AWS schedules maintenance with EventBridge; local and portable processes run it themselves.
if(target!=="aws"){const timer=setInterval(()=>{void app.subscriptions.maintenance().catch(()=>console.warn("Subscription maintenance will retry"));},60000);timer.unref();}
