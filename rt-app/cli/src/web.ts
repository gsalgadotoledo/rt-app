import { adminAssets } from '@gsalgadotoledo/rt-app-config/paths';
import { fileURLToPath } from 'node:url';
import {host} from "./host.js";
import { AdminIdentity, passwordVerifier } from "@gsalgadotoledo/rt-app-myadmin/backend";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { inspectInstallation, validateModules } from "@gsalgadotoledo/rt-app-installer";
let port = Number(process.env.SETUP_PORT ?? 4011),
  token = randomBytes(32).toString("hex");
let origin = "http://127.0.0.1:" + port,
  root = adminAssets();
const rootIdentity = process.env.ADMIN_PASSWORD
  ? new AdminIdentity(
      await passwordVerifier(process.env.ADMIN_PASSWORD),
      randomBytes(48).toString("hex"),
    )
  : undefined;
let job: any = { state: "idle", messages: [] };
function authorized(header: string | undefined) {
  const value = Buffer.from(header ?? ""),
    expected = Buffer.from("Bearer " + token);
  return value.length === expected.length && timingSafeEqual(value, expected);
}
function terraformReady() {
  try {
    const r = spawnSync(
      process.env.TF_CLI_PATH ?? "terraform",
      ["version", "-json"],
      { encoding: "utf8" },
    );
    const [major, minor] = JSON.parse(r.stdout)
      .terraform_version.split(".")
      .map(Number);
    return r.status === 0 && (major > 1 || (major === 1 && minor >= 11));
  } catch {
    return false;
  }
}
const server = createServer(async (req, res) => {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (
    req.headers.host !== "127.0.0.1:" + port ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    return reply(403, { error: "Origin not allowed" });
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname === "/api/__dev/setup" && req.method === "GET") {
    return reply(200, {
      local: true,
      installer: true,
      installed: false,
      adminPasswordConfigured: !!rootIdentity,
    });
  }
  if (
    url.pathname === "/api/admin/identity/auth/login" &&
    req.method === "POST"
  ) {
    if (!authorized("Bearer " + (req.headers["x-setup-token"] ?? "")))
      return reply(401, { error: "Open admin from the local starter URL" });
    if (!rootIdentity)
      return reply(503, { error: "Set ADMIN_PASSWORD and restart" });
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4096)
          return reply(413, { error: "Body too large" });
      }
      return reply(
        200,
        await rootIdentity.login(
          JSON.parse(raw).password,
          req.socket.remoteAddress ?? "local",
        ),
      );
    } catch (e: any) {
      return reply(e.status ?? 400, {
        error: e.status ? e.message : "Invalid login request",
      });
    }
  }
  if (url.pathname.startsWith("/api/setup/")) {
    let authenticated = false;
    try {
      authenticated = !!(await rootIdentity?.auth.actor(
        req.headers.authorization,
      ));
    } catch {}
    if (!authenticated)
      return reply(401, {
        error: "Sign in with ADMIN_PASSWORD first",
      });
    try {
      if (req.method === "GET" && url.pathname === "/api/setup/status")
        return reply(200, job);
      if (req.method === "GET" && url.pathname === "/api/setup/requirements")
        return reply(200, {
          node: process.versions.node,
          defaults: {
            multiEnvironment: process.env.RT_APP_MULTI_ENVIRONMENT === "true",
            region: process.env.AWS_REGION ?? "us-east-1",
            stack: process.env.RT_APP_NAME ?? "rt-app-hello",
            mailFrom: process.env.MAIL_FROM ?? "",
            repository: process.env.GITHUB_REPOSITORY ?? "",
          },
          terraform: terraformReady(),
          modules: JSON.parse(await readFile("modules.json", "utf8")).modules,
        });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 32768)
          return reply(413, { error: "Input too large" });
      }
      const input = JSON.parse(raw);
      if (req.method === "POST" && url.pathname === "/api/setup/inspect") {
        if (job.state === "running")
          return reply(409, { error: "Installation in progress" });
        return reply(200, await inspectInstallation(input.config));
      }
      if (req.method === "POST" && url.pathname === "/api/setup/install") {
        if (job.state === "running")
          return reply(409, { error: "Installation in progress" });
        validateModules(input.modules, await host.applicationModules?.() ?? []);
        if (!input.config?.stack || input.confirmation !== input.config.stack)
          return reply(400, { error: "Confirm the exact stack name" });
        if (!terraformReady())
          return reply(400, {
            error: "Install Terraform >= 1.11 before continuing",
          });
        job = { state: "running", messages: [] };
        const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js",import.meta.url))], {
          stdio: ["pipe", "pipe", "ignore"],
        });
        let pending = "";
        child.stdout.on("data", (chunk) => {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event.message) job.messages.push(event.message);
              if (event.result) job.result = event.result;
              if (event.error) job.error = event.error;
            } catch {}
          }
        });
        child.on("error", () => {
          job.state = "failed";
          job.error = "Could not start the installer";
        });
        child.on("exit", (code) => {
          job.state = code === 0 && job.result ? "done" : "failed";
          if (!job.result && !job.error)
            job.error =
              "Installation interrupted; check Terraform before resuming";
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(input));
        return reply(202, { state: "running" });
      }
      return reply(404, { error: "Route not found" });
    } catch (e: any) {
      return reply(400, { error: e.name === "Error" ? e.message : e.name });
    }
  }
  if (url.pathname.startsWith("/api/"))
    return reply(404, { error: "Backend not installed yet" });
  if (req.method !== "GET") return reply(405, { error: "Method not allowed" });
  try {
    const path = resolve(
      root,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!path.startsWith(root + "/"))
      return reply(403, { error: "Path not allowed" });
    const body = await readFile(path);
    const type =
      (
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        } as Record<string, string>
      )[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    return reply(404, { error: "File missing; run npm run build" });
  }
});
server.listen(port, "127.0.0.1", () => {
  port = (server.address() as import("node:net").AddressInfo).port;
  origin = "http://127.0.0.1:" + port;
  const setupUrl = origin + "/#setup=" + token;
  process.send?.({ setupUrl });
  console.log(
    "Instalador local privado (conserva esta terminal abierta):\n" + setupUrl,
  );
});
process.once("disconnect", () => server.close());
