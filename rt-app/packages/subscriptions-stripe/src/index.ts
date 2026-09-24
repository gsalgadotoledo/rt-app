import Stripe from "stripe";
import { HttpError, type Actor } from "@gsalgadotoledo/rt-app-contracts";
import type {
  BillingProvider,
  Plan,
} from "@gsalgadotoledo/rt-app-subscriptions";
export class StripeBilling implements BillingProvider {
  readonly mode = "stripe" as const;
  private stripe: Stripe;
  constructor(
    secret: string,
    private webhookSecret: string,
    readonly publishableKey: string,
  ) {
    if (!secret || !webhookSecret || !publishableKey)
      throw new Error(
        "Stripe secret, webhook secret and publishable key are required",
      );
    this.stripe = new Stripe(secret, { maxNetworkRetries: 1, timeout: 10000 });
  }
  /** Create a Stripe customer using the caller's stable idempotency key; return its provider ID. */
  async customer(user: Actor, key: string) {
    return (
      await this.stripe.customers.create(
        { email: user.email, metadata: { rtAppUserId: user.id } },
        { idempotencyKey: key },
      )
    ).id;
  }
  /** Fetch a subscription and reject cross-customer access before reads or writes. */
  private async owned(customer: string, subscriptionId: string) {
    const subscription: any =
      await this.stripe.subscriptions.retrieve(subscriptionId);
    if (subscription.customer !== customer)
      throw new HttpError(403, "Subscription owner mismatch");
    return subscription;
  }
  /** Normalize current/legacy expanded invoice secrets; unexpanded invoices return null. */
  private secret(subscription: any) {
    const invoice = subscription.latest_invoice;
    return typeof invoice === "object"
      ? (invoice?.confirmation_secret?.client_secret ??
          invoice?.payment_intent?.client_secret ??
          null)
      : null;
  }
  /** Validate the remote price against local minor units, currency and licensed interval. */
  async validatePlan(plan: Plan, customer?: string): Promise<void> {
    if (!plan.stripePriceId)
      throw new HttpError(400, "This plan needs a Stripe price");
    const price = await this.stripe.prices.retrieve(plan.stripePriceId);
    const r = price.recurring;
    const days = r
      ? { day: 1, week: 7, month: 30, year: 365 }[r.interval] * r.interval_count
      : 0;
    if (
      !price.active ||
      price.unit_amount !== plan.amount ||
      price.currency !== plan.currency ||
      days !== plan.periodDays ||
      r?.usage_type !== "licensed"
    )
      throw new HttpError(
        400,
        "Stripe price must match the configured amount, currency and billing interval",
      );
    if (plan.amount === 0) {
      const record = customer
        ? await this.stripe.customers.retrieve(customer)
        : undefined;
      if (
        !record ||
        record.deleted ||
        !record.invoice_settings.default_payment_method
      )
        throw new HttpError(
          400,
          "Add a payment method before selecting a zero-price billing plan",
        );
    }
  }
  /** Create/change one recurring item; incomplete payment never silently grants active access. */
  async change(
    customer: string,
    plan: Plan,
    subscriptionId: string | undefined,
    key: string,
  ) {
    const price = { id: plan.stripePriceId! };
    if (subscriptionId) {
      const existing = await this.owned(customer, subscriptionId);
      if (["canceled", "incomplete_expired"].includes(existing.status))
        subscriptionId = undefined;
    }
    let subscription: any;
    if (subscriptionId) {
      const old = await this.owned(customer, subscriptionId);
      if (old.items.data.length !== 1)
        throw new HttpError(409, "Only one subscription item is supported");
      if (!["active", "past_due", "incomplete"].includes(old.status))
        throw new HttpError(
          409,
          "Resolve the existing subscription before changing plans",
        );
      subscription = await this.stripe.subscriptions.update(
        subscriptionId,
        {
          items: [{ id: old.items.data[0].id, price: price.id }],
          payment_behavior: "pending_if_incomplete",
          proration_behavior: "always_invoice",
          expand: ["latest_invoice.confirmation_secret"],
        },
        { idempotencyKey: customer + ":" + key },
      );
    } else
      subscription = await this.stripe.subscriptions.create(
        {
          customer,
          items: [{ price: price.id }],
          payment_behavior: "default_incomplete",
          payment_settings: { save_default_payment_method: "on_subscription" },
          expand: ["latest_invoice.confirmation_secret"],
          metadata: { rtAppPlanId: plan.id },
        },
        { idempotencyKey: customer + ":" + key },
      );
    return {
      subscriptionId: subscription.id,
      clientSecret: this.secret(subscription),
      status: subscription.status,
    };
  }
  /** Create a card SetupIntent; return only the ID and client secret needed by secure client fields. */
  async setup(customer: string, key: string) {
    const intent = await this.stripe.setupIntents.create(
      { customer, payment_method_types: ["card"], usage: "off_session" },
      { idempotencyKey: customer + ":setup:" + key },
    );
    return { setupId: intent.id, clientSecret: intent.client_secret };
  }
  /** Accept a succeeded, customer-owned SetupIntent; update defaults only after all ownership checks. */
  async setPaymentMethod(
    customer: string,
    setupId: string,
    subscriptionId?: string,
  ) {
    const intent = await this.stripe.setupIntents.retrieve(setupId);
    if (
      intent.customer !== customer ||
      intent.status !== "succeeded" ||
      typeof intent.payment_method !== "string"
    )
      throw new HttpError(400, "Complete payment-method verification first");
    // Verify all ownership before making the first external mutation.
    // A foreign subscription must not partially update this customer's settings.
    if (subscriptionId) await this.owned(customer, subscriptionId);
    await this.stripe.customers.update(customer, {
      invoice_settings: { default_payment_method: intent.payment_method },
    });
    if (subscriptionId) {
      await this.stripe.subscriptions.update(subscriptionId, {
        default_payment_method: intent.payment_method,
      });
    }
  }
  /** Schedule end-of-period cancellation; preserve access until the provider period ends. */
  async cancel(customer: string, subscriptionId: string, key: string) {
    await this.owned(customer, subscriptionId);
    await this.stripe.subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: customer + ":cancel:" + key },
    );
    return { ok: true };
  }
  /** Return bounded invoices/card summaries and currency-separated totals; partial marks more invoices. */
  async snapshot(customer: string, subscriptionId?: string) {
    const [invoices, methods] = await Promise.all([
      this.stripe.invoices.list({ customer, limit: 100 }),
      this.stripe.paymentMethods.list({ customer, type: "card", limit: 10 }),
    ]);
    let subscription: any = subscriptionId
      ? await this.owned(customer, subscriptionId)
      : undefined;
    const base = {
      invoices: invoices.data.map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        amountPaid: i.amount_paid,
        amountDue: i.amount_remaining,
        currency: i.currency,
        createdAt: i.created * 1000,
        url: i.hosted_invoice_url,
        pdf: i.invoice_pdf,
      })),
      paymentMethods: methods.data.map((m) => ({
        id: m.id,
        brand: m.card?.brand,
        last4: m.card?.last4,
        expMonth: m.card?.exp_month,
        expYear: m.card?.exp_year,
      })),
      totals: Object.entries(
        invoices.data.reduce(
          (a: Record<string, { paid: number; due: number }>, i) => {
            a[i.currency] ??= { paid: 0, due: 0 };
            a[i.currency].paid += i.amount_paid;
            a[i.currency].due += i.status === "open" ? i.amount_remaining : 0;
            return a;
          },
          {},
        ),
      ).map(([currency, x]) => ({ currency, ...x })),
      partial: invoices.has_more,
    };
    if (!subscription) return base;
    const item = subscription.items.data[0];
    return {
      ...base,
      subscriptionId: subscription.id,
      priceId: item.price.id,
      status: subscription.status === "active" ? "active" : subscription.status,
      periodStart: item.current_period_start * 1000,
      periodEnd: item.current_period_end * 1000,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    };
  }
  /** Verify the original webhook bytes/signature and extract only routing identity. */
  verify(raw: string, signature: string) {
    const event = this.stripe.webhooks.constructEvent(
      raw,
      signature,
      this.webhookSecret,
    );
    const obj: any = event.data.object;
    return {
      id: event.id,
      type: event.type,
      customer:
        typeof obj.customer === "string"
          ? obj.customer
          : (obj.customer?.id ?? ""),
    };
  }
}

export { StripeCatalog } from "./catalog.js";
