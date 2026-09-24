import test from "node:test";
import assert from "node:assert/strict";
import { AwsMonitor } from "../dist/index.js";
import { STSClient } from "@aws-sdk/client-sts";
import { BudgetsClient } from "@aws-sdk/client-budgets";

test("budget report scopes the account, follows pagination and caches results", async (t) => {
  t.mock.method(STSClient.prototype, "send", async () => ({ Account: "123" }));
  let calls = 0;
  t.mock.method(BudgetsClient.prototype, "send", async (command) => {
    assert.equal(command.input.AccountId, "123");
    calls++;
    return calls === 1
      ? {
          NextToken: "next",
          Budgets: [
            {
              BudgetName: "Monthly",
              BudgetLimit: { Amount: "10", Unit: "USD" },
              CalculatedSpend: { ActualSpend: { Amount: "3" } },
              CostFilters: { Service: ["AWS Lambda"] },
              LastUpdatedTime: new Date("2026-01-01"),
            },
          ],
        }
      : { Budgets: [{ BudgetName: "Empty" }] };
  });
  const monitor = new AwsMonitor();
  const route = monitor
    .feature()
    .endpoints.find((e) => e.path === "/aws/budgets");
  assert.equal(route.access, "owner");
  const result = await route.handle();
  assert.equal(result.items[0].spent, "3");
  assert.equal(result.items[1].spent, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(await route.handle(), result);
  assert.equal(calls, 2);
});

test("missing AWS identity fails closed without reporting a zero balance", async (t) => {
  t.mock.method(STSClient.prototype, "send", async () => ({}));
  t.mock.method(BudgetsClient.prototype, "send", async () =>
    assert.fail("No unscoped budget request"),
  );
  await assert.rejects(new AwsMonitor().budgets(), { status: 502 });
});
