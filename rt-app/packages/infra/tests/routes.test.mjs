import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Infra, SimulatedInfraDriver } from "../dist/index.js";

test("infra owner routes configure, inspect, plan and apply using the local driver only", async () => {
  const infra = new Infra(new MemoryStore(), new SimulatedInfraDriver());
  const routes = infra.feature().endpoints;
  const run = (method, path, body = {}, id = "") =>
    routes
      .find((e) => e.method === method && e.path === path)
      .handle({
        actor: { id: "root", role: "owner" },
        params: { id },
        request: { body, query: {} },
      });
  for (const route of routes) assert.equal(route.access, "owner");
  const settings = await run("GET", "/infra/settings");
  await run("PUT", "/infra/settings", {
    version: settings.version,
    mode: "role",
    region: "us-east-1",
  });
  assert.match(
    JSON.stringify(await run("POST", "/infra/test")),
    /local-simulation/,
  );
  const plan = await run("POST", "/infra/plans", {
    name: "rt-app-test-table",
    kind: "table",
  });
  assert.equal((await run("GET", "/infra/plans")).items.length, 1);
  assert.equal(
    (
      await run(
        "POST",
        "/infra/plans/:id/apply",
        { confirmation: plan.spec.name },
        plan.id,
      )
    ).state,
    "applied",
  );
  assert.ok((await run("GET", "/infra/audit")).items.length >= 3);
});
