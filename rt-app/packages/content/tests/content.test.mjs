import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { contentFeature, defaultHome } from "../dist/index.js";

test("home defaults, validated edits and stale-write protection", async () => {
  const feature = contentFeature(new MemoryStore());
  const home = feature.endpoints.find((e) => e.path === "/");
  const read = feature.endpoints.find(
    (e) => e.path === "/content/settings" && e.method === "GET",
  );
  const edit = feature.endpoints.find((e) => e.method === "PUT");
  const save = (body) => edit.handle({ request: { body } });
  assert.deepEqual(await home.handle(), defaultHome);
  assert.equal((await read.handle()).version, 0);
  await assert.rejects(save({ values: defaultHome }), { status: 400 });
  await assert.rejects(
    save({ version: 0, values: { title: "", content: "ok" } }),
    { status: 400 },
  );
  const result = await save({
    version: 0,
    values: { title: " Hello ", content: " World " },
  });
  assert.equal(result.version, 1);
  assert.deepEqual(await home.handle(), { title: "Hello", content: "World" });
  await assert.rejects(save({ version: 0, values: defaultHome }), {
    status: 409,
  });
  assert.equal((await read.handle()).version, 1);
  assert.equal((await save({ version: 1, values: defaultHome })).version, 2);
});
