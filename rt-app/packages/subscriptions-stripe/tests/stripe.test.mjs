import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { StripeBilling } from "../dist/index.js";
test("Stripe signature verifies original bytes and rejects modified JSON", () => {
  const sdk = new Stripe("sk_test_fake"),
    provider = new StripeBilling("sk_test_fake", "whsec_test", "pk_test_fake");
  const raw = JSON.stringify({
    id: "evt_test",
    type: "invoice.paid",
    data: { object: { customer: "cus_test" } },
  });
  const signature = sdk.webhooks.generateTestHeaderString({
    payload: raw,
    secret: "whsec_test",
  });
  assert.deepEqual(provider.verify(raw, signature), {
    id: "evt_test",
    type: "invoice.paid",
    customer: "cus_test",
  });
  assert.throws(() => provider.verify(raw + " ", signature));
});
test("payment method cannot be attached using another customer setup intent", async () => {
  const provider = new StripeBilling(
    "sk_test_fake",
    "whsec_test",
    "pk_test_fake",
  );
  provider.stripe = {
    setupIntents: {
      retrieve: async () => ({
        customer: "cus_other",
        status: "succeeded",
        payment_method: "pm_test",
      }),
    },
  };
  await assert.rejects(
    provider.setPaymentMethod("cus_owner", "seti_test"),
    /verification/,
  );
});
test("subscription reads reject another customer before exposing billing state", async () => {
  const provider = new StripeBilling(
    "sk_test_fake",
    "whsec_test",
    "pk_test_fake",
  );
  provider.stripe = {
    subscriptions: { retrieve: async () => ({ customer: "cus_other" }) },
  };
  await assert.rejects(
    provider.cancel("cus_owner", "sub_other", "key"),
    /owner/,
  );
});
