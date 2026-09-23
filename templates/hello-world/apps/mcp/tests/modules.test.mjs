import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApplication } from "@gsalgadotoledo/rt-app-framework";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { moduleClient } from "@gsalgadotoledo/rt-app-cli/module-tools";
import { fileURLToPath } from "node:url";

const make = (local) =>
  createApplication({
    store: new MemoryStore(),
    mailer: new LocalMailbox(),
    secret: "test-secret".repeat(8),
    localAdminAccess: local,
  });
const request = (path, method = "GET", body = {}) => ({
  path,
  method,
  body,
  query: {},
  headers: {},
  ip: "127.0.0.1",
});

test("catalog is opt-in, unique and protected by admin authentication", async () => {
  assert.equal((await make(false).handle(request("/admin/tools"))).status, 401);
  const result = await make(true).handle(request("/admin/tools"));
  assert.equal(result.status, 200);
  assert.equal(
    new Set(result.body.map((t) => t.name)).size,
    result.body.length,
  );
  assert.ok(result.body.some((t) => t.name === "subscriptions_plan_archive"));
  assert.ok(
    result.body.every((t) => t.path.startsWith("/admin/") && t.description),
  );
  assert.ok(!result.body.some((t) => t.path.includes("webhook")));
});

test("CLI client and MCP discover and execute the same backend operations", async (t) => {
  const app = make(true);
  await app.migrate();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = new URL(req.url, "http://localhost");
    const result = await app.handle({
      ...request(url.pathname, req.method, text ? JSON.parse(text) : {}),
      query: Object.fromEntries(url.searchParams),
    });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const old = process.env.RT_APP_API_URL;
  process.env.RT_APP_API_URL = base;
  t.after(() => {
    if (old === undefined) delete process.env.RT_APP_API_URL;
    else process.env.RT_APP_API_URL = old;
  });
  const cli = await moduleClient();
  const settings = await cli.call("subscriptions_settings_get");
  const archived = await cli.call("subscriptions_plan_archive", {
    body: { version: settings.version, id: "pro" },
  });
  assert.equal(
    archived.values.plans.find((p) => p.id === "pro").archived,
    true,
  );
  await assert.rejects(
    cli.call("subscriptions_plan_archive", {
      body: { version: settings.version, id: "pro" },
    }),
    /409/,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.mjs", import.meta.url))],
    env: { ...process.env, RT_APP_API_URL: base },
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const catalog = await client.listTools();
  assert.deepEqual(
    catalog.tools.map((t) => t.name).sort(),
    cli.tools.map((t) => t.name).sort(),
  );
  const result = await client.callTool({
    name: "subscriptions_settings_get",
    arguments: {},
  });
  assert.equal(
    JSON.parse(result.content[0].text).values.plans.find((p) => p.id === "pro")
      .archived,
    true,
  );
  const error = await client.callTool({
    name: "subscriptions_plan_archive",
    arguments: { body: { id: "missing", version: archived.version } },
  });
  assert.equal(error.isError, true);
});
