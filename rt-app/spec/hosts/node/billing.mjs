// Subjects: subscriptions-ledger, subscriptions-credits.
// Thin adapters over the pure functions of @gsalgadotoledo/rt-app-subscriptions. Other languages
// must expose the same method names with the same positional arguments (see the contracts).
import {
  LEDGER,
  Subscriptions,
  applyTotals,
  defaults,
  emptyTotals,
  ledgerKey,
  ledgerWrite,
  rollover,
  validateCredits,
} from "@gsalgadotoledo/rt-app-subscriptions";
import { currencyDecimals, validCurrency, validMinorAmount } from "@gsalgadotoledo/rt-app-subscriptions/currency";
import { memoryStore } from "./storage.mjs";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** `used` travels as a table {productId: {"<start>": credits}}; missing entries are 0. */
const usedFrom = (table) => (productId, start) => {
  const product = table && Object.hasOwn(table, productId) ? table[productId] : undefined;
  const key = String(start);
  return (product && Object.hasOwn(product, key) ? product[key] : undefined) ?? 0;
};

const ledger = () => ({
  emptyTotals: () => emptyTotals(),
  LEDGER: (userId) => LEDGER(userId),
  ledgerKey: (at, seed, sequence) => ledgerKey(at, seed, given(sequence)),
  ledgerWrite: (userId, entry, seed, sequence) => ledgerWrite(userId, entry, seed, given(sequence)),
  applyTotals: (totals, entry) => applyTotals(given(totals), entry),
  rollover: (previous, current, used, now) => rollover(given(previous), given(current), usedFrom(used), now),
});

/** init.credits: stored credit settings (validated like an admin save); defaults when absent. */
async function credits(init) {
  const rows = init.credits ? [{ pk: "SUB_CONFIG", sk: "settings", version: 1, data: { credits: validateCredits(init.credits) } }] : [];
  const service = new Subscriptions(await memoryStore(rows), undefined, async () => {}, () => 0);
  return {
    defaults: () => structuredClone(defaults.credits),
    validateCredits: (input) => validateCredits(input),
    // Pricing only: the account preview (userId/productId) needs the whole service and is not part of the contract.
    estimate: (input) => service.estimate({ rateId: input?.rateId, inputTokens: input?.inputTokens, outputTokens: given(input?.outputTokens) }),
    validCurrency: (code) => validCurrency(code),
    currencyDecimals: (code) => currencyDecimals(code),
    validMinorAmount: (amount, code) => validMinorAmount(amount, code),
  };
}

export const subjects = {
  "subscriptions-ledger": ledger,
  "subscriptions-credits": credits,
};
