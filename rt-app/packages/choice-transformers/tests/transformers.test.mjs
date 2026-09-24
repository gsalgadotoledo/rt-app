import { test } from "node:test";
import assert from "node:assert/strict";
import { TransformersChoiceProvider } from "../dist/index.js";
const input = {
  context: "Refund",
  question: "Which team?",
  options: [{ id: "billing", description: "Invoices" }, { id: "sales" }],
};
test("maps reordered zero-shot labels without pretending calibration", async () => {
  const p = new TransformersChoiceProvider(async (text, labels, options) => {
    assert.match(text, /Refund/);
    assert.equal(options.multi_label, false);
    return { labels: labels.toReversed(), scores: [0.1, 0.9] };
  }, "open-model");
  assert.deepEqual((await p.predict(input)).probabilities, {
    billing: 0.9,
    sales: 0.1,
  });
  assert.equal((await p.predict(input)).semantics, "uncalibrated-scores");
  await assert.rejects(p.predict(input, AbortSignal.abort()));
  for (const result of [
    { labels: [], scores: [] },
    { labels: ["sales", "sales"], scores: [0.5, 0.5] },
    { labels: ["wrong", "sales"], scores: [1, 0] },
  ])
    await assert.rejects(
      new TransformersChoiceProvider(async () => result, "m").predict(input),
    );
  const c = new AbortController();
  await assert.rejects(
    new TransformersChoiceProvider(async () => {
      c.abort();
      return { labels: [], scores: [] };
    }, "m").predict(input, c.signal),
  );
});
