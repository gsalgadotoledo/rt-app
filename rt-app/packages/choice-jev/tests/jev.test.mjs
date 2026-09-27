import { test } from "node:test";
import assert from "node:assert/strict";
import { JevProvider } from "../dist/index.js";
const input = {
  context: "Refund",
  question: "Which team?",
  options: [{ id: "billing", description: "Invoices" }, { id: "sales" }],
};
test("official Jev envelope, response and private failure handling", async () => {
  const transport = async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options.redirect, "error");
    const b = JSON.parse(options.body);
    assert.deepEqual(b.questions.decision.criteria, {
      billing: "Invoices",
      sales: null,
    });
    return Response.json({
      model: "jev-test",
      answers: {
        decision: {
          type: "choice",
          probabilities: { billing: 1, sales: 0 },
          confidence: 1,
        },
      },
    });
  };
  const provider = new JevProvider("test", "test", transport);
  assert.equal((await provider.predict(input)).model, "jev-test");
  await provider.predict(input, new AbortController().signal);
  for (const args of [[""], ["key", ""], ["key", "model", transport, 0]])
    assert.throws(() => new JevProvider(...args));
  await assert.rejects(
    new JevProvider(
      "key",
      "m",
      async () => new Response("secret", { status: 429 }),
    ).predict(input),
    /HTTP 429/,
  );
  await assert.rejects(
    new JevProvider("key", "m", async () => Response.json({})).predict(input),
    /Invalid Jev/,
  );
  // Malformed bodies never echo their content; a JSON null is an invalid response, not a TypeError.
  for (const body of ["secret-token", "null", ""])
    await assert.rejects(
      new JevProvider("key", "m", async () => new Response(body)).predict(input),
      (error) => error.message === "Invalid Jev response",
    );
  assert.equal(new JevProvider("key").id, "jev");
});
