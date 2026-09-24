import test from "node:test";
import assert from "node:assert/strict";
import {validateInstallation} from "@gsalgadotoledo/rt-app-installer";
import {infrastructureProviders} from "@gsalgadotoledo/rt-app-infra/installation";
test("installer accepts only AWS and a valid repository", () => {
 const config={provider:"aws",region:"us-east-1",stack:"rt-app-test",mailFrom:"sender@example.test",repository:"owner/repo"};
 assert.equal(infrastructureProviders.length,1);
 assert.equal(validateInstallation(config),config);
 for(const override of [{provider:"azure"},{stack:"arbitrary"},{repository:"https://github.com/owner/repo"}]) assert.throws(()=>validateInstallation({...config,...override}));
});

test("seeding after migrations is opt-in and forwards only the demo secret", async () => {
  const { seedEnvironment } = await import("@gsalgadotoledo/rt-app-installer");
  const progress = [];
  const calls = [];
  const host = {
    progress: message => progress.push(message),
    seedApplication: async (secrets, modules) => { calls.push({ secrets, modules }); return ["users:demo-identities"]; },
  };
  assert.deepEqual(await seedEnvironment(host, "stage", { DEMO_PASSWORD: "x" }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(
    await seedEnvironment(host, "stage", { RT_APP_SEED: "true", DEMO_PASSWORD: "Demo-2026-password", JWT_SECRET: "never" }, ["users"]),
    ["users:demo-identities"],
  );
  assert.deepEqual(calls, [{ secrets: { DEMO_PASSWORD: "Demo-2026-password" }, modules: ["users"] }]);
  assert.deepEqual(progress, ["stage: seeding", "stage: seeded users:demo-identities"]);
  host.seedApplication = async () => [];
  await seedEnvironment(host, "prod", { RT_APP_SEED: "true" });
  assert.equal(progress.at(-1), "prod: seeded nothing new");
  await assert.rejects(seedEnvironment({ progress() {} }, "stage", { RT_APP_SEED: "true" }), /requires a host/);
});
