import { HttpError, Conflict, type Actor } from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL } from "@gsalgadotoledo/rt-app-nosql";
import type { BillingProvider, Plan } from "./index.js";
/** Explicit simulation: no card numbers, no real charges, persisted in the selected store. */
export class LocalBilling implements BillingProvider {
  readonly mode = "local" as const;
  constructor(private store: NoSQL) {
    if (process.env.NODE_ENV === "production")
      throw new Error("Local billing cannot run in production");
  }
  async customer(user: Actor) {
    return "local_" + user.id;
  }
  async change(
    customer: string,
    plan: Plan,
    _subscriptionId: string | undefined,
    key: string,
  ) {
    const existing = await this.store.get("LOCAL_BILLING_OP#" + customer, key);
    if (existing) return existing.data;
    const old = await this.store.get("LOCAL_BILLING", customer),
      now = Date.now(),
      continuing = old?.data.status === "active" && old.data.periodEnd > now;
    const invoice = {
      id: "sim_" + key,
      number: "SIMULATION",
      status: "paid",
      amountPaid: plan.amount,
      amountDue: 0,
      currency: plan.currency,
      createdAt: now,
    };
    const result = {
      subscriptionId: "sub_" + customer,
      status: "active",
      clientSecret: null,
    };
    await this.store.transact([
      {
        row: {
          pk: "LOCAL_BILLING",
          sk: customer,
          version: (old?.version ?? 0) + 1,
          data: {
            ...old?.data,
            ...result,
            priceId: plan.stripePriceId ?? plan.id,
            plan,
            periodStart: continuing ? old.data.periodStart : now,
            periodEnd: continuing
              ? old.data.periodEnd
              : now + plan.periodDays * 86400000,
            invoices: [invoice, ...(old?.data.invoices ?? [])],
            paymentMethods: [{ brand: "simulation", last4: "0000" }],
            cancelAtPeriodEnd: false,
          },
        },
        expected: old?.version ?? null,
      },
      {
        row: {
          pk: "LOCAL_BILLING_OP#" + customer,
          sk: key,
          version: 1,
          data: result,
        },
        expected: null,
      },
    ]);
    return result;
  }
  async setup() {
    return { simulated: true };
  }
  async setPaymentMethod() {
    return;
  }
  async cancel(customer: string) {
    const old = await this.store.get("LOCAL_BILLING", customer);
    if (!old) throw new HttpError(404, "No subscription");
    await this.store.transact([
      {
        row: {
          ...old,
          version: old.version + 1,
          data: { ...old.data, cancelAtPeriodEnd: true },
        },
        expected: old.version,
      },
    ]);
    return { ok: true };
  }
  async snapshot(customer: string) {
    const row = await this.store.get("LOCAL_BILLING", customer);
    if (!row) return { invoices: [], paymentMethods: [], totals: [] };
    const data = structuredClone(row.data),
      totals: Record<string, { paid: number; due: number }> = {};
    for (const i of data.invoices) {
      totals[i.currency] ??= { paid: 0, due: 0 };
      totals[i.currency].paid += i.amountPaid;
      totals[i.currency].due += i.amountDue;
    }
    if (data.cancelAtPeriodEnd && Date.now() >= data.periodEnd)
      data.status = "canceled";
    return {
      ...data,
      simulated: true,
      totals: Object.entries(totals).map(([currency, v]) => ({
        currency,
        ...v,
      })),
    };
  }
  verify(): never {
    throw new Error("Local simulation does not accept Stripe webhooks");
  }
  async simulate(customer: string, status: string) {
    if (!["active", "past_due", "canceled"].includes(status))
      throw new HttpError(400, "Invalid simulated state");
    const row = await this.store.get("LOCAL_BILLING", customer);
    if (!row) throw new HttpError(404, "No simulated subscription");
    await this.store.transact([
      {
        row: {
          ...row,
          version: row.version + 1,
          data: { ...row.data, status },
        },
        expected: row.version,
      },
    ]);
  }
}
