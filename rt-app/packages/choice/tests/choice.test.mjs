import { test } from "node:test";
import assert from "node:assert/strict";
import { Choice, validateChoice } from "../dist/index.js";
const input = {
  context: "Refund",
  question: "Which team?",
  options: [{ id: "billing", description: "Invoices" }, { id: "sales" }],
};
const prediction = {
  probabilities: { billing: 0.9, sales: 0.1 },
  model: "test",
  semantics: "model-probabilities",
  confidence: 0.7,
};
const choice = (result = prediction) =>
  new Choice({ id: "fake", predict: async () => result });
test("typed decisions preserve confidence separately and abstain on uncertainty", async () => {
  const r = await choice().decide(input);
  assert.equal(r.selected, "billing");
  assert.equal(r.confidence, 0.7);
  assert.equal(r.accepted, true);
  assert.equal(
    (await choice().decide(input, { minProbability: 0.99 })).requiresReview,
    true,
  );
  const uncal = choice({ ...prediction, semantics: "uncalibrated-scores" });
  assert.equal((await uncal.decide(input)).accepted, false);
  assert.equal(
    (await uncal.decide(input, { allowUncalibrated: true })).accepted,
    true,
  );
  assert.equal(
    (
      await choice({
        ...prediction,
        probabilities: { billing: 0.5, sales: 0.5 },
      }).decide(input, { minProbability: 0, minMargin: 0 })
    ).accepted,
    false,
  );
  const feature = choice().feature();
  assert.equal(feature.endpoints[0].explicitGrant, true);
  assert.equal(
    (await feature.endpoints[0].handle({ request: { body: input } })).selected,
    "billing",
  );
});
test("invalid inputs, distributions and policy fail before unsafe selection", async () => {
  for (const bad of [
    null,
    { ...input, question: "" },
    { ...input, options: [] },
    { ...input, options: [{ id: "a" }, { id: "a" }] },
    { ...input, options: [{ id: "a b" }, { id: "c" }] },
    { ...input, options: [{ id: "a", description: 4 }, { id: "b" }] },
    { ...input, context: "x".repeat(128001) },
  ])
    assert.throws(() => validateChoice(bad));
  for (const result of [
    { ...prediction, probabilities: { billing: 0.5, sales: 0.2 } },
    { ...prediction, probabilities: { billing: NaN, sales: 0 } },
    { ...prediction, probabilities: { billing: 1, other: 0 } },
    { ...prediction, confidence: 2 },
    { ...prediction, model: "" },
    { ...prediction, semantics: "fake" },
    null,
  ])
    await assert.rejects(choice(result).decide(input));
  await assert.rejects(choice().decide(input, { minMargin: -1 }));
  await assert.rejects(choice().decide(input, {}, AbortSignal.abort()));
  const controller = new AbortController();
  await assert.rejects(
    new Choice({
      id: "fake",
      predict: async () => {
        controller.abort();
        return prediction;
      },
    }).decide(input, {}, controller.signal),
  );
});
