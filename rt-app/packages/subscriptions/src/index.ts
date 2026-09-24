import { planIdFromName } from "./plan-id.js";
import { validCurrency, validMinorAmount } from "./currency.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  Conflict,
  schemaMigration,
  type Actor,
  type Feature,
} from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL, Row, Write } from "@gsalgadotoledo/rt-app-nosql";
import {
  LEDGER,
  applyTotals,
  emptyTotals,
  ledgerWrite,
  rollover,
  type CurrentWindow,
  type LedgerEntry,
  type LedgerKind,
  type LedgerSource,
  type WindowState,
} from "./ledger.js";
export * from "./ledger.js";
export interface Product {
  id: string;
  name: string;
  credits: number;
  dailyLimit: number;
  weeklyLimit: number;
  daySeconds: number;
  weekSeconds: number;
}
export interface Plan {
  id: string;
  name: string;
  amount: number;
  currency: string;
  periodDays: number;
  stripePriceId?: string;
  stripeProductId?: string;
  stripeManaged?: boolean;
  family?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, string>;
  products: Product[];
  enabled: boolean;
  archived?: boolean;
}
/** Credits charged per model/function; decimals allowed (e.g. 0.25 credits per 1k tokens). */
export interface CreditRate {
  id: string;
  name: string;
  inputPer1k: number;
  outputPer1k: number;
  /** Minimum credits charged per request. */
  minimum: number;
}
export interface CreditSettings {
  /** Price of a top-up pack; also the money value of one credit (amountMinor / credits). */
  pack: { credits: number; amountMinor: number; currency: string };
  rates: CreditRate[];
}
export interface Settings {
  paymentRequired: boolean;
  notifications: boolean;
  reminderDays: number;
  plans: Plan[];
  credits: CreditSettings;
}
export interface CatalogPublisher {
  publish(
    plan: Plan,
    namespace: string,
    previous?: Plan,
  ): Promise<{ stripePriceId: string; stripeProductId: string }>;
}
export interface BillingProvider {
  readonly mode: "local" | "stripe";
  readonly publishableKey?: string;
  validatePlan?(plan: Plan, customer?: string): Promise<void>;
  simulate?(customer: string, status: string): Promise<void>;
  customer(user: Actor, key: string): Promise<string>;
  change(
    customer: string,
    plan: Plan,
    subscriptionId: string | undefined,
    key: string,
  ): Promise<any>;
  setup(customer: string, key: string): Promise<any>;
  setPaymentMethod(
    customer: string,
    setupId: string,
    subscriptionId?: string,
  ): Promise<void>;
  cancel(customer: string, subscriptionId: string, key: string): Promise<any>;
  snapshot(customer: string, subscriptionId?: string): Promise<any>;
  verify(
    raw: string,
    signature: string,
  ): { id: string; type: string; customer: string };
}
export const defaults: Settings = {
  paymentRequired: false,
  notifications: true,
  reminderDays: 3,
  credits: {
    pack: { credits: 1000, amountMinor: 1000, currency: "usd" },
    rates: [
      { id: "standard", name: "Standard model", inputPer1k: 1, outputPer1k: 3, minimum: 1 },
      { id: "advanced", name: "Advanced model", inputPer1k: 5, outputPer1k: 15, minimum: 1 },
    ],
  },
  plans: [
    {
      id: "starter",
      name: "Starter",
      amount: 0,
      currency: "usd",
      periodDays: 30,
      enabled: true,
      products: [
        {
          id: "api",
          name: "API credits",
          credits: 1000,
          dailyLimit: 100,
          weeklyLimit: 500,
          daySeconds: 86400,
          weekSeconds: 604800,
        },
      ],
    },
    {
      id: "pro",
      name: "Pro",
      amount: 2000,
      currency: "usd",
      periodDays: 30,
      enabled: true,
      products: [
        {
          id: "api",
          name: "API credits",
          credits: 10000,
          dailyLimit: 1000,
          weeklyLimit: 5000,
          daySeconds: 86400,
          weekSeconds: 604800,
        },
      ],
    },
    {
      id: "max",
      family: "max",
      version: "0.0.1",
      name: "Max",
      description: "For growing teams with higher usage",
      amount: 5000,
      currency: "usd",
      periodDays: 30,
      enabled: true,
      products: [
        {
          id: "api",
          name: "API credits",
          credits: 50000,
          dailyLimit: 5000,
          weeklyLimit: 25000,
          daySeconds: 86400,
          weekSeconds: 604800,
        },
      ],
    },
  ],
};
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new HttpError(400, "Invalid identifier");
  return value;
};
const integer = (n: unknown, min = 0, max = 1e9) => {
  if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max)
    throw new HttpError(400, "Invalid numeric setting");
  return Number(n);
};
const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const write = (
  old: Row | undefined,
  pk: string,
  sk: string,
  data: any,
): Write => ({
  row: { pk, sk, version: (old?.version ?? 0) + 1, data },
  expected: old?.version ?? null,
});
/** Non-negative rate with at most 4 decimals, so estimates are reproducible. */
const rate = (n: unknown) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e6 || Math.round(n * 1e4) !== n * 1e4)
    throw new HttpError(400, "Invalid credit rate");
  return n;
};
export function validateCredits(input: any): CreditSettings {
  const pack = input?.pack;
  const currency = String(pack?.currency ?? "").toLowerCase();
  if (!validCurrency(currency)) throw new HttpError(400, "Invalid currency");
  const amountMinor = integer(pack?.amountMinor);
  if (!validMinorAmount(amountMinor, currency)) throw new HttpError(400, "Invalid amount for currency");
  if (!Array.isArray(input?.rates) || input.rates.length > 50)
    throw new HttpError(400, "Use at most 50 credit rates");
  const rates: CreditRate[] = input.rates.map((r: any) => ({
    id: id(r.id),
    name: String(r.name ?? "").trim().slice(0, 80),
    inputPer1k: rate(r.inputPer1k),
    outputPer1k: rate(r.outputPer1k),
    minimum: integer(r.minimum ?? 0),
  }));
  if (rates.some((r) => !r.name) || new Set(rates.map((r) => r.id)).size !== rates.length)
    throw new HttpError(400, "Duplicate or unnamed credit rates");
  return { pack: { credits: integer(pack.credits, 1), amountMinor, currency }, rates };
}
function validateMetadata(value: any): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 20
  )
    throw new HttpError(400, "Use at most 20 metadata entries");
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9_-]{1,40}$/.test(key) ||
      typeof item !== "string" ||
      item.length > 500 ||
      ["B_version", "State", "family", "rtAppPlanId", "rtAppCatalog"].includes(
        key,
      )
    )
      throw new HttpError(400, "Invalid or reserved metadata key");
  }
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, string>;
}
function planContent(p: Plan) {
  return {
    id: p.id,
    family: p.family ?? p.id,
    name: p.name,
    description: p.description ?? "",
    amount: p.amount,
    currency: p.currency,
    periodDays: p.periodDays,
    products: p.products,
    metadata: p.metadata ?? {},
  };
}
export function validateSettings(input: any): Settings {
  if (
    typeof input?.paymentRequired !== "boolean" ||
    typeof input.notifications !== "boolean" ||
    !Array.isArray(input.plans) ||
    input.plans.length < 1 ||
    input.plans.length > 20
  )
    throw new HttpError(400, "Invalid subscription settings");
  const plans: Plan[] = input.plans.map((p: any) => ({
    id: id(p.id),
    family: id(p.family ?? p.id),
    description: String(p.description ?? "").slice(0, 500),
    metadata: validateMetadata(p.metadata ?? {}),
    name: String(p.name ?? "").slice(0, 80),
    amount: integer(p.amount),
    currency: validCurrency(p.currency)
      ? p.currency
      : (() => {
          throw new HttpError(400, "Invalid currency");
        })(),
    periodDays: integer(p.periodDays, 1, 366),
    enabled: p.enabled === true && p.archived !== true,
    archived: p.archived === true,
    ...(p.stripePriceId ? { stripePriceId: id(p.stripePriceId) } : {}),
    products:
      Array.isArray(p.products) &&
      p.products.length > 0 &&
      p.products.length <= 20
        ? p.products.map((x: any) => ({
            id: id(x.id),
            name: String(x.name ?? "").slice(0, 80),
            credits: integer(x.credits),
            dailyLimit: integer(x.dailyLimit),
            weeklyLimit: integer(x.weeklyLimit),
            daySeconds: integer(x.daySeconds, 60, 86400 * 31),
            weekSeconds: integer(x.weekSeconds, 60, 86400 * 366),
          }))
        : (() => {
            throw new HttpError(400, "A plan needs products");
          })(),
  }));
  if (
    new Set(plans.map((p) => p.id)).size !== plans.length ||
    new Set(plans.filter((p) => p.stripePriceId).map((p) => p.stripePriceId))
      .size !== plans.filter((p) => p.stripePriceId).length ||
    plans.some(
      (p) =>
        !p.name ||
        !validMinorAmount(p.amount, p.currency) ||
        new Set(p.products.map((x) => x.id)).size !== p.products.length ||
        p.products.some((x) => !x.name),
    )
  )
    throw new HttpError(400, "Duplicate or unnamed plans/products");
  return {
    paymentRequired: input.paymentRequired,
    notifications: input.notifications,
    reminderDays: integer(input.reminderDays, 0, 30),
    plans,
    // Settings saved before credit rates existed keep working with the defaults.
    credits: validateCredits(input.credits ?? defaults.credits),
  };
}

const DAY = 86400000;
const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
export class Subscriptions {
  constructor(
    readonly store: NoSQL,
    readonly provider?: BillingProvider,
    private notify?: (message: {
      to: string;
      subject: string;
      text: string;
    }) => Promise<void>,
    private now = () => Date.now(),
    private catalogFactory?: (secret?: string) => CatalogPublisher,
  ) {}
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; i < 8; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof Conflict) || i === 7) throw e;
      }
    }
    throw new HttpError(409, "Refresh and try again");
  }

  async settings() {
    const row = await this.store.get("SUB_CONFIG", "settings");
    return {
      version: row?.version ?? 0,
      values: {
        ...(row?.data ?? structuredClone(defaults)),
        plans: (row?.data.plans ?? structuredClone(defaults.plans)).map(
          (p: Plan) => ({ ...p, version: p.version ?? "0.0.1" }),
        ),
        credits: row?.data.credits ?? structuredClone(defaults.credits),
      } as Settings,
      provider: this.provider?.mode ?? "none",
      catalogAvailable: !!this.catalogFactory,
      catalogOperation: row?.data.catalogOperation,
    };
  }

  async saveSettings(
    input: any,
    actorId: string,
    restored?: { id: string; version: string },
  ) {
    const values = validateSettings(input.values),
      old = await this.store.get("SUB_CONFIG", "settings");
    if ((old?.version ?? 0) !== input.version) throw new Conflict();
    if (old?.data.catalogOperation)
      throw new HttpError(
        409,
        "Resume the pending Stripe synchronization before editing plans",
      );
    const history: Write[] = [];
    const previousPlans: Plan[] = old?.data.plans ?? defaults.plans;
    for (const prior of previousPlans)
      if (!values.plans.some((p) => p.id === prior.id))
        throw new HttpError(
          400,
          "Disable a plan instead of removing or renaming its ID",
        );
    values.plans = values.plans.map((plan) => {
      const prior = previousPlans.find((p) => p.id === plan.id);
      const changed =
        prior &&
        (restored?.id === plan.id ||
          digest(planContent(prior)) !== digest(planContent(plan)));
      const version = prior?.version ?? "0.0.1";
      if (changed)
        history.push(
          write(undefined, "SUB_PLAN_HISTORY#" + prior.id, version, prior),
        );
      return {
        ...plan,
        stripeManaged: !!prior?.stripeManaged,
        version: changed
          ? version.replace(/(\d+)$/, (n) => String(Number(n) + 1))
          : version,
        ...(!changed && prior?.stripePriceId
          ? { stripePriceId: prior.stripePriceId }
          : { stripePriceId: undefined }),
        ...(!changed && prior?.stripeProductId
          ? { stripeProductId: prior.stripeProductId }
          : {}),
      };
    });
    if (values.paymentRequired && !this.provider)
      throw new HttpError(
        400,
        "Configure a payment adapter before requiring payments",
      );
    await this.store.transact([
      write(old, "SUB_CONFIG", "settings", {
        ...values,
        catalogNamespace: old?.data.catalogNamespace,
      }),
      ...history,
      write(undefined, "SUB_AUDIT", randomUUID(), {
        action: "settings",
        ...(restored
          ? { restoredPlan: restored.id, restoredFrom: restored.version }
          : {}),
        actorId,
        at: this.now(),
      }),
    ]);
    return this.settings();
  }
  /** Apply one catalog action through the same versioned settings transaction as the UI. */
  async editPlan(action: string, input: any, actorId: string) {
    const settings = await this.settings();
    if (settings.version !== input.version) throw new Conflict();
    const plans = settings.values.plans;
    const index = plans.findIndex((p) => p.id === input.id);
    if (action === "create") {
      if (!input.plan || typeof input.plan.name !== "string")
        throw new HttpError(400, "plan.name is required");
      const id = planIdFromName(
        input.plan.name,
        plans.map((p) => p.id),
      );
      plans.push({
        ...input.plan,
        id,
        family: input.plan.family || id,
        enabled: false,
      });
    } else {
      if (index < 0) throw new HttpError(404, "Plan not found");
      if (action === "update") {
        plans[index] = { ...plans[index], ...input.plan, id: plans[index].id };
      } else if (action === "archive" || action === "unarchive") {
        plans[index] = {
          ...plans[index],
          archived: action === "archive",
          enabled: false,
        };
      } else if (action !== "version")
        throw new HttpError(400, "Unknown plan action");
    }
    // Publication is explicit: callers can inspect the saved version before touching Stripe.
    return this.saveSettings(
      settings,
      actorId,
      action === "version"
        ? { id: input.id, version: plans[index].version ?? "0.0.1" }
        : undefined,
    );
  }

  async restorePlan(planId: string, input: any, actorId: string) {
    if (
      typeof input?.fromVersion !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(input.fromVersion)
    )
      throw new HttpError(400, "Invalid plan version");
    const previous = await this.store.get(
      "SUB_PLAN_HISTORY#" + planId,
      input.fromVersion,
    );
    if (!previous) throw new HttpError(404, "Plan version not found");
    const settings = await this.settings();
    if (settings.version !== input.version) throw new Conflict();
    if (!settings.values.plans.some((p) => p.id === planId))
      throw new HttpError(404, "Plan not found");
    settings.values.plans = settings.values.plans.map((p) =>
      p.id === planId
        ? ({
            ...previous.data,
            id: planId,
            enabled: p.enabled,
            archived: p.archived,
          } as Plan)
        : p,
    );
    return this.saveSettings(settings, actorId, {
      id: planId,
      version: input.fromVersion,
    });
  }

  private async account(userId: string) {
    return this.store.get("SUB_ACCOUNTS", userId);
  }

  private normalized(data: any) {
    const next = structuredClone(data),
      now = this.now();
    if (
      next.mode === "none" &&
      next.plan &&
      next.status === "active" &&
      !next.cancelAtPeriodEnd &&
      now >= next.periodEnd
    ) {
      const step = next.plan.periodDays * 86400000;
      const periods = Math.floor((now - next.periodStart) / step);
      next.periodStart += periods * step;
      next.periodEnd = next.periodStart + step;
      next.counters = {};
    }
    for (const p of next.plan?.products ?? []) {
      let c = next.counters?.[p.id];
      if (!c) {
        next.counters ??= {};
        c = next.counters[p.id] = {
          period: 0,
          day: 0,
          week: 0,
          dayStart: next.periodStart,
          weekStart: next.periodStart,
        };
      }
      for (const [window, seconds] of [
        ["day", p.daySeconds],
        ["week", p.weekSeconds],
      ] as const) {
        const field = window + "Start";
        if (now >= c[field] + seconds * 1000) {
          c[field] +=
            Math.floor((now - c[field]) / (seconds * 1000)) * seconds * 1000;
          c[window] = 0;
        }
      }
    }
    if (next.adminGrant) next.adminGrant = this.normalized(next.adminGrant);
    return next;
  }

  private effective(data: any) {
    return data.adminGrant?.status === "active" &&
      this.now() < data.adminGrant.periodEnd
      ? data.adminGrant
      : data;
  }

  private valid(data: any) {
    if (!data?.plan || data.status !== "active" || this.now() >= data.periodEnd)
      throw new HttpError(402, "Subscription is inactive or expired");
  }

  // -------------------------------------------------------------------------
  // Credit ledger. Every helper mutates `data` and returns writes for the caller's transaction.
  // -------------------------------------------------------------------------

  /** Plan allowance still usable now: the tightest of the day, week and period windows. */
  private allowanceLeft(data: any, productId: string) {
    const entitlement = this.effective(data);
    if (!entitlement?.plan || entitlement.status !== "active" || this.now() >= entitlement.periodEnd) return 0;
    const product: Product | undefined = entitlement.plan.products.find((p: Product) => p.id === productId);
    const c = entitlement.counters?.[productId];
    if (!product || !c) return 0;
    return Math.max(0, Math.min(product.dailyLimit - c.day, product.weeklyLimit - c.week, product.credits - c.period));
  }

  /** Credits usable now for a product: remaining plan allowance plus additional (non-expiring) credits. */
  private available(data: any, productId: string) {
    return this.allowanceLeft(data, productId) + (data.creditBalance?.[productId] ?? 0);
  }

  /** Allowance windows of the active entitlement, keyed so a plan change closes the previous ones. */
  private windows(data: any): CurrentWindow | undefined {
    const entitlement = this.effective(data);
    if (!entitlement?.plan || entitlement.status !== "active" || this.now() >= entitlement.periodEnd) return undefined;
    return {
      key: (entitlement === data ? "own:" : "admin:") + entitlement.plan.id,
      periodStart: entitlement.periodStart,
      periodMs: entitlement.plan.periodDays * 86400000,
      products: entitlement.plan.products.map((p: Product) => ({
        id: p.id,
        name: p.name,
        weeklyLimit: p.weeklyLimit,
        weekSeconds: p.weekSeconds,
        start: entitlement.counters?.[p.id]?.weekStart ?? entitlement.periodStart,
      })),
    };
  }

  /** Allowance/expiry entries owed since the last write, computed from the stored (raw) counters. */
  private pendingWindows(raw: any, data: any) {
    const previous: WindowState | undefined = raw?.ledgerWindows;
    const counters = previous?.key.startsWith("admin:") ? raw?.adminGrant?.counters : raw?.counters;
    return rollover(
      previous,
      this.windows(data),
      (productId, start) => (counters?.[productId]?.weekStart === start ? counters[productId].week : 0),
      this.now(),
    );
  }

  /** Append one statement entry and fold it into the account totals. */
  private ledgerEntry(userId: string, data: any, entry: Omit<LedgerEntry, "id" | "available">, seed: string): Write {
    data.ledgerSequence = (data.ledgerSequence ?? 0) + 1;
    const { entry: full, write } = ledgerWrite(
      userId,
      { ...entry, ...(entry.productId ? { available: this.available(data, entry.productId) } : {}) },
      seed,
      data.ledgerSequence,
    );
    data.ledgerTotals = applyTotals(data.ledgerTotals, full);
    return write;
  }

  /** Persist the window rollover (weekly allowance and expiry) before any other change. */
  private settle(userId: string, raw: any, data: any): Write[] {
    const { entries, state } = this.pendingWindows(raw, data);
    data.ledgerWindows = state ?? null;
    return entries.map(({ seed, ...entry }) => this.ledgerEntry(userId, data, { ...entry, source: "system" }, seed));
  }

  /** Daily subscription statistics for the overview (new and canceled subscriptions). */
  private async statsWrite(event: "new" | "canceled"): Promise<Write> {
    const key = "day:" + dayKey(this.now());
    const row = await this.store.get("SUB_STATS", key);
    const data = { new: 0, canceled: 0, ...row?.data };
    data[event] += 1;
    return write(row, "SUB_STATS", key, data);
  }

  async me(userId: string) {
    const row = await this.account(userId),
      settings = await this.settings();
    const data = row
      ? this.normalized(row.data)
      : { userId, status: "none", counters: {}, notifications: true };
    const entitlement = this.effective(data);
    const { billingOperation, adminGrant, ...safe } = data;
    const effective = {
      ...safe,
      ...(entitlement === data ? {} : entitlement),
      userId,
    };
    const pending = billingOperation
      ? await this.store.get("SUB_BILLING_OP#" + userId, billingOperation)
      : undefined;
    return {
      ...effective,
      assignedByAdmin: entitlement !== data,
      pendingBillingRequest: pending
        ? {
            requestId: billingOperation,
            action: pending.data.input?.action,
            planId: pending.data.input?.planId,
          }
        : undefined,
      active:
        entitlement.status === "active" &&
        this.now() < entitlement.periodEnd &&
        (!settings.values.paymentRequired ||
          entitlement.mode === "admin" ||
          entitlement.mode === this.provider?.mode),
      version: row?.version ?? 0,
      paymentRequired: settings.values.paymentRequired,
      provider: this.provider?.mode ?? "none",
      publishableKey: this.provider?.publishableKey,
      plans: settings.values.plans.filter((p) => p.enabled),
      usage: (entitlement.plan?.products ?? []).map((p: Product) => {
        const c = entitlement.counters[p.id];
        return {
          ...p,
          used: c.period,
          remaining: this.available(data, p.id),
          allowanceLeft: this.allowanceLeft(data, p.id),
          extraCredits: data.creditBalance?.[p.id] ?? 0,
          dayUsed: c.day,
          weekUsed: c.week,
          dayResetAt: c.dayStart + p.daySeconds * 1000,
          weekResetAt: c.weekStart + p.weekSeconds * 1000,
        };
      }),
    };
  }

  async preferences(userId: string, enabled: unknown) {
    if (typeof enabled !== "boolean")
      throw new HttpError(400, "Invalid notification preference");
    return this.retry(async () => {
      const row = await this.account(userId);
      await this.store.transact([
        write(row, "SUB_ACCOUNTS", userId, {
          ...row?.data,
          userId,
          notifications: enabled,
        }),
      ]);
      return { ok: true };
    });
  }

  async change(user: Actor, planId: string, key: string) {
    id(key);
    const existing = await this.account(user.id);
    if (
      existing?.data.adminGrant &&
      this.effective(existing.data) !== existing.data
    )
      throw new HttpError(
        409,
        "An administrator-assigned plan is active. Contact your administrator to change it.",
      );
    const config = await this.settings(),
      plan = config.values.plans.find((p) => p.id === planId && p.enabled);
    if (!plan) throw new HttpError(404, "Plan not found");
    if (
      config.values.paymentRequired &&
      !(await this.store.get("SUB_BILLING_OP#" + user.id, key))
    ) {
      await this.provider?.validatePlan?.(
        plan,
        (await this.account(user.id))?.data.customerId,
      );
    }
    if (config.values.paymentRequired)
      return this.billingOperation(
        user,
        key,
        { action: "change", planId, plan },
        async (data, request) => {
          const selected = request.plan as Plan;
          const result = await this.provider!.change(
            data.customerId,
            selected,
            data.subscriptionId,
            key,
          );
          return { ...result, requestedPlan: selected };
        },
      );
    return this.retry(async () => {
      const old = await this.account(user.id),
        op = await this.store.get("SUB_OP#" + user.id, key);
      if (op) {
        if (op.data.planId !== planId) throw new Conflict();
        return op.data.result;
      }
      if (old?.data.customerId || old?.data.subscriptionId)
        throw new HttpError(
          409,
          "Cancel and reconcile the paid subscription before switching to unpaid mode",
        );
      const now = this.now(),
        previous = old?.data,
        continuing = previous?.status === "active" && now < previous.periodEnd;
      if (continuing && previous.plan.id === planId)
        throw new HttpError(409, "Already subscribed to this plan");
      const data = this.normalized({
        ...previous,
        userId: user.id,
        email: user.email,
        plan,
        status: "active",
        mode: "none",
        cancelAtPeriodEnd: false,
        periodStart: continuing ? previous.periodStart : now,
        periodEnd: continuing
          ? previous.periodEnd
          : now + plan.periodDays * 86400000,
        counters: continuing ? previous.counters : {},
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
      const result = { ok: true };
      const settled = this.settle(user.id, previous, data);
      const planEntry = this.ledgerEntry(
        user.id,
        data,
        {
          at: now,
          kind: "plan",
          source: "user",
          credits: 0,
          planId,
          reason: (continuing ? "Plan changed to " : "Plan started: ") + plan.name,
          requestId: key,
        },
        "plan:" + key,
      );
      await this.store.transact([
        write(old, "SUB_ACCOUNTS", user.id, data),
        write(undefined, "SUB_OP#" + user.id, key, { planId, result }),
        planEntry,
        ...settled,
        ...(continuing ? [] : [await this.statsWrite("new")]),
        write(undefined, "SUB_AUDIT", randomUUID(), {
          userId: user.id,
          action: "plan-change",
          planId,
          at: now,
        }),
      ]);
      return result;
    });
  }

  private async billingOperation(
    user: Actor,
    key: string,
    input: any,
    run: (data: any, input: any) => Promise<any>,
  ) {
    if (!this.provider) throw new HttpError(503, "Payments are not configured");
    id(key);
    const fingerprint = digest({ ...input, plan: undefined });
    let old = await this.account(user.id),
      operation = await this.store.get("SUB_BILLING_OP#" + user.id, key);
    if (operation && operation.data.fingerprint !== fingerprint)
      throw new Conflict();
    if (operation?.data.result) return operation.data.result;
    if (old?.data.billingOperation && old.data.billingOperation !== key)
      throw new HttpError(
        409,
        "Another billing operation is pending. Retry it before starting a new one.",
      );
    if (!operation) {
      await this.store.transact([
        write(undefined, "SUB_BILLING_OP#" + user.id, key, {
          fingerprint,
          input,
          started: this.now(),
        }),
        write(old, "SUB_ACCOUNTS", user.id, {
          ...old?.data,
          userId: user.id,
          email: user.email,
          billingOperation: key,
        }),
      ]);
    } else if (this.now() - operation.data.started > 23 * 3600000)
      throw new HttpError(
        409,
        "Billing operation needs reconciliation; do not create another payment",
      );
    old = await this.account(user.id);
    if (!old?.data.customerId) {
      const customerId = await this.provider.customer(
        user,
        "customer-" + user.id,
      );
      await this.retry(async () => {
        const row = await this.account(user.id),
          mapping = await this.store.get("SUB_CUSTOMERS", customerId);
        await this.store.transact([
          write(row, "SUB_ACCOUNTS", user.id, { ...row!.data, customerId }),
          ...(mapping
            ? []
            : [
                write(undefined, "SUB_CUSTOMERS", customerId, {
                  userId: user.id,
                }),
              ]),
        ]);
      });
    }
    const data = (await this.account(user.id))!.data,
      request = (await this.store.get("SUB_BILLING_OP#" + user.id, key))!.data
        .input,
      result = await run(data, request);
    await this.retry(async () => {
      const row = (await this.account(user.id))!,
        op = (await this.store.get("SUB_BILLING_OP#" + user.id, key))!;
      if (op.data.result) return;
      if (row.data.billingOperation !== key) throw new Conflict();
      await this.store.transact([
        write(row, "SUB_ACCOUNTS", user.id, {
          ...row.data,
          billingOperation: null,
          ...(result.subscriptionId
            ? { subscriptionId: result.subscriptionId }
            : {}),
          ...(result.requestedPlan
            ? { pendingPlan: result.requestedPlan }
            : {}),
        }),
        write(op, op.pk, op.sk, { ...op.data, result }),
      ]);
    });
    await this.sync(user.id);
    return result;
  }

  async setupPayment(user: Actor, key: string) {
    return this.billingOperation(user, key, { action: "setup" }, (data) =>
      this.provider!.setup(data.customerId, key),
    );
  }

  async setPayment(user: Actor, setupId: string) {
    const row = await this.account(user.id);
    if (!row?.data.customerId || !this.provider)
      throw new HttpError(400, "No billing customer");
    await this.provider.setPaymentMethod(
      row.data.customerId,
      id(setupId),
      row.data.subscriptionId,
    );
    return { ok: true };
  }

  async cancel(user: Actor, key: string) {
    const row = await this.account(user.id);
    if (row?.data.subscriptionId && this.provider)
      return this.billingOperation(user, key, { action: "cancel" }, (data) =>
        this.provider!.cancel(data.customerId, data.subscriptionId, key),
      );
    return this.retry(async () => {
      const row = await this.account(user.id);
      if (!row || !this.effective(row.data).plan)
        throw new HttpError(404, "No subscription");
      if (row.data.cancelAtPeriodEnd) return { ok: true };
      const data = { ...row.data, cancelAtPeriodEnd: true };
      await this.store.transact([
        write(row, "SUB_ACCOUNTS", user.id, data),
        this.ledgerEntry(
          user.id,
          data,
          { at: this.now(), kind: "plan", source: "user", credits: 0, planId: row.data.plan?.id, reason: "Subscription canceled; access continues until the period ends", requestId: key },
          "cancel:" + key,
        ),
        await this.statsWrite("canceled"),
      ]);
      return { ok: true };
    });
  }

  async sync(userId: string) {
    if (!this.provider) return;
    const old = await this.account(userId);
    if (!old?.data.customerId) return;
    const snapshot = await this.provider.snapshot(
      old.data.customerId,
      old.data.subscriptionId,
    );
    if (!snapshot.subscriptionId) return;
    // Remote retrieval precedes a conditional write: conflicting syncs are retried with a fresh snapshot.
    const config = await this.settings(),
      plan =
        this.provider.mode === "local"
          ? (old.data.pendingPlan ?? old.data.plan)
          : ((await this.store.get("SUB_PLAN_PRICES", snapshot.priceId))?.data
              .plan ??
            config.values.plans.find(
              (p) => p.stripePriceId === snapshot.priceId,
            ) ??
            (old.data.plan?.stripePriceId === snapshot.priceId
              ? old.data.plan
              : undefined));
    if (!plan)
      throw new HttpError(
        409,
        "Stripe price is not mapped to a configured plan",
      );
    const renewed = old.data.periodStart !== snapshot.periodStart;
    const data = this.normalized({
      ...old.data,
      ...snapshot,
      plan,
      mode: this.provider.mode,
      counters: renewed ? {} : old.data.counters,
      updatedAt: this.now(),
      createdAt: old.data.createdAt ?? this.now(),
    });
    const now = this.now();
    const wasActive = old.data.status === "active" && old.data.plan && now < old.data.periodEnd;
    const isActive = data.status === "active" && now < data.periodEnd;
    // A payment problem (past_due, incomplete) is neither a new subscription nor a cancellation.
    const wasSubscribed =
      Boolean(old.data.plan) && old.data.status !== "canceled" && now < old.data.periodEnd;
    const writes: Write[] = [...this.settle(userId, old.data, data)];
    // Billing events on the statement: paid period (start, renewal or plan change) and cancellation.
    if (isActive && (renewed || old.data.plan?.id !== plan.id))
      writes.push(
        this.ledgerEntry(
          userId,
          data,
          {
            at: now,
            kind: "plan",
            source: "billing",
            credits: 0,
            planId: plan.id,
            reason: (wasActive ? (renewed ? "Plan renewed: " : "Plan changed to ") : "Plan started: ") + plan.name,
            amountMinor: plan.amount,
            currency: plan.currency,
          },
          "billing:" + plan.id + ":" + data.periodStart + ":" + randomUUID(),
        ),
      );
    if (isActive && !wasSubscribed) writes.push(await this.statsWrite("new"));
    const canceled =
      (data.cancelAtPeriodEnd && !old.data.cancelAtPeriodEnd) ||
      (data.status === "canceled" && old.data.status !== "canceled" && !old.data.cancelAtPeriodEnd);
    if (canceled) {
      writes.push(
        this.ledgerEntry(
          userId,
          data,
          { at: now, kind: "plan", source: "billing", credits: 0, planId: plan.id, reason: "Subscription canceled: " + plan.name },
          "billing-cancel:" + plan.id + ":" + randomUUID(),
        ),
      );
      writes.push(await this.statsWrite("canceled"));
    }
    await this.store.transact([write(old, "SUB_ACCOUNTS", userId, data), ...writes]);
  }

  async billing(userId: string) {
    const row = await this.account(userId);
    return row?.data.customerId && this.provider
      ? this.provider.snapshot(row.data.customerId, row.data.subscriptionId)
      : {
          invoices: [],
          paymentMethods: [],
          amountDue: 0,
          totalPaid: 0,
          currency: null,
        };
  }
  /**
   * Atomic pre-charge. The plan allowance (bounded by the day, week and period windows) is used
   * first; the rest comes from additional credits, which are not bound by those windows.
   * A stable requestId never charges twice; callers must honor `replayed`.
   * Fails with 402 when there is no active entitlement and 429 when credits are insufficient.
   */
  async consume(
    userId: string,
    productId: string,
    credits: number,
    requestId: string,
    meta: { reason?: string; kind?: LedgerKind; source?: LedgerSource; actorId?: string; details?: LedgerEntry["details"] } = {},
  ) {
    id(requestId);
    integer(credits, 1);
    return this.retry(async () => {
      const op = await this.store.get("SUB_USAGE#" + userId, requestId);
      if (op) {
        if (op.data.productId !== productId || op.data.credits !== credits)
          throw new Conflict();
        return { ...op.data, replayed: true };
      }
      const old = await this.account(userId),
        data = this.normalized(old?.data ?? {});
      const entitlement = this.effective(data);
      this.valid(entitlement);
      if (
        (await this.settings()).values.paymentRequired &&
        entitlement.mode !== "admin" &&
        entitlement.mode !== this.provider?.mode
      )
        throw new HttpError(402, "A paid subscription is required");
      const product: Product | undefined = entitlement.plan.products.find(
        (p: Product) => p.id === productId,
      );
      if (!product)
        throw new HttpError(403, "Product is not included in your plan");
      const settled = this.settle(userId, old?.data, data);
      const counter = entitlement.counters[productId];
      const balance = data.creditBalance?.[productId] ?? 0;
      const fromAllowance = Math.min(credits, this.allowanceLeft(data, productId));
      const fromBalance = credits - fromAllowance;
      if (fromBalance > balance) {
        const window =
          counter.day >= product.dailyLimit ? "day" : counter.week >= product.weeklyLimit ? "week" : "period";
        throw new HttpError(
          429,
          `Subscription ${window} limit reached. Add credits or wait for the reset.`,
        );
      }
      data.creditBalance ??= {};
      data.creditBalance[productId] = balance - fromBalance;
      // Window counters track the plan allowance only; additional credits live in creditBalance.
      counter.period += fromAllowance;
      counter.day += fromAllowance;
      counter.week += fromAllowance;
      data.totalConsumed = (data.totalConsumed ?? 0) + credits;
      const at = this.now();
      const receipt = {
        requestId,
        productId,
        credits,
        fromAllowance,
        fromBalance,
        at,
        replayed: false,
      };
      const entry = this.ledgerEntry(
        userId,
        data,
        {
          at,
          kind: meta.kind ?? "usage",
          source: meta.source ?? "api",
          credits: -credits,
          productId,
          reason: meta.reason ?? product.name + " usage",
          requestId,
          fromAllowance,
          fromBalance,
          ...(meta.actorId ? { actorId: meta.actorId } : {}),
          ...(meta.details ? { details: meta.details } : {}),
        },
        "usage:" + requestId,
      );
      await this.store.transact([
        write(old, "SUB_ACCOUNTS", userId, data),
        write(undefined, "SUB_USAGE#" + userId, requestId, receipt),
        ...settled,
        entry,
      ]);
      return receipt;
    });
  }

  /**
   * Record a credit (+) or debit (−) on a user's statement from application code or the admin.
   * Credits add non-expiring additional credits; debits are charged like usage (allowance first).
   * Idempotent per requestId. `amountMinor`/`currency` record money paid for a purchase.
   * @example recordCredits("u1", {requestId:"stripe-pi_1", productId:"api", credits:1000, kind:"purchase", reason:"Top-up", amountMinor:1000, currency:"usd"})
   */
  async recordCredits(
    userId: string,
    input: {
      requestId: string;
      productId: string;
      credits: number;
      reason: string;
      kind?: "purchase" | "adjustment" | "grant" | "usage";
      source?: LedgerSource;
      actorId?: string;
      amountMinor?: number;
      currency?: string;
      details?: LedgerEntry["details"];
    },
  ) {
    const key = id(input.requestId),
      productId = id(input.productId);
    const reason = String(input.reason ?? "").trim();
    if (!reason || reason.length > 300) throw new HttpError(400, "A short reason is required");
    const kind = input.kind ?? (input.credits > 0 ? "adjustment" : "usage");
    if (!["purchase", "adjustment", "grant", "usage"].includes(kind)) throw new HttpError(400, "Invalid entry type");
    if (!Number.isSafeInteger(input.credits) || input.credits === 0 || Math.abs(input.credits) > 1e9)
      throw new HttpError(400, "Credits must be a non-zero integer");
    const source = input.source ?? "api";
    if (!["system", "admin", "billing", "user", "api"].includes(source)) throw new HttpError(400, "Invalid source");
    const money =
      input.amountMinor !== undefined || input.currency !== undefined
        ? (() => {
            const currency = String(input.currency ?? "").toLowerCase();
            const amountMinor = integer(input.amountMinor);
            if (!validCurrency(currency) || !validMinorAmount(amountMinor, currency))
              throw new HttpError(400, "Invalid amount for currency");
            return { amountMinor, currency };
          })()
        : {};
    const meta = { reason, kind, source, actorId: input.actorId, details: input.details } as const;
    if (input.credits < 0) return this.consume(userId, productId, -input.credits, key, meta);
    const fingerprint = digest({ ...input, kind, source });
    return this.retry(async () => {
      const prior = await this.store.get("SUB_LEDGER_OP#" + userId, key);
      if (prior) {
        if (prior.data.fingerprint !== fingerprint) throw new Conflict();
        return { ...prior.data.result, replayed: true };
      }
      const settings = await this.settings();
      if (!settings.values.plans.some((p) => p.products.some((x) => x.id === productId)))
        throw new HttpError(404, "Product not found");
      const old = await this.account(userId);
      const data = this.normalized({ ...old?.data, userId });
      const settled = this.settle(userId, old?.data, data);
      data.creditBalance ??= {};
      data.creditBalance[productId] = integer((data.creditBalance[productId] ?? 0) + input.credits, 0);
      const at = this.now();
      const entry = this.ledgerEntry(
        userId,
        data,
        {
          at,
          kind,
          source,
          credits: input.credits,
          productId,
          reason,
          requestId: key,
          ...money,
          ...(input.actorId ? { actorId: input.actorId } : {}),
          ...(input.details ? { details: input.details } : {}),
        },
        "record:" + key,
      );
      const result = { requestId: key, productId, credits: input.credits, available: this.available(data, productId), at };
      await this.store.transact([
        write(old, "SUB_ACCOUNTS", userId, data),
        write(undefined, "SUB_LEDGER_OP#" + userId, key, { fingerprint, result }),
        ...settled,
        entry,
      ]);
      return { ...result, replayed: false };
    });
  }

  /**
   * Price a request: credits for a rate (model) and token counts, their money value, and, for a
   * user, how the charge would split between allowance and additional credits. Never writes.
   * @example estimate({rateId:"standard", inputTokens:1000, outputTokens:500}) → {credits:3, valueMinor:3, currency:"usd"}
   */
  async estimate(input: { rateId: string; inputTokens: number; outputTokens?: number; userId?: string; productId?: string }) {
    const { credits: config } = (await this.settings()).values;
    const selected = config.rates.find((r) => r.id === input.rateId);
    if (!selected) throw new HttpError(404, "Credit rate not found");
    const inputTokens = integer(input.inputTokens, 0, 1e10);
    const outputTokens = integer(input.outputTokens ?? 0, 0, 1e10);
    const exact = (inputTokens / 1000) * selected.inputPer1k + (outputTokens / 1000) * selected.outputPer1k;
    // Round up to whole credits (tolerating float noise) and apply the per-request minimum.
    const credits = Math.max(selected.minimum, Math.ceil(Math.round(exact * 1e6) / 1e6));
    const valueMinor = Math.round((credits * config.pack.amountMinor) / config.pack.credits);
    const result: any = {
      rate: selected,
      inputTokens,
      outputTokens,
      exactCredits: Math.round(exact * 1e4) / 1e4,
      credits,
      valueMinor,
      currency: config.pack.currency,
    };
    if (input.userId) {
      const productId = id(input.productId ?? "api");
      const row = await this.account(id(input.userId));
      const data = this.normalized(row?.data ?? {});
      const allowance = this.allowanceLeft(data, productId);
      const balance = data.creditBalance?.[productId] ?? 0;
      const fromAllowance = Math.min(credits, allowance);
      const fromBalance = credits - fromAllowance;
      result.account = {
        userId: input.userId,
        productId,
        allowanceLeft: allowance,
        additionalCredits: balance,
        available: allowance + balance,
        fromAllowance,
        fromBalance,
        allowed: fromBalance <= balance && credits > 0,
        availableAfter: Math.max(0, allowance + balance - credits),
      };
    }
    return result;
  }

  /** Estimate a model request and charge it atomically (see estimate and consume). */
  async consumeUsage(
    userId: string,
    productId: string,
    usage: { rateId: string; inputTokens: number; outputTokens?: number },
    requestId: string,
  ) {
    const estimate = await this.estimate(usage);
    const receipt = await this.consume(userId, productId, estimate.credits, requestId, {
      reason: estimate.rate.name + " request",
      details: { rateId: estimate.rate.id, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens },
    });
    return { ...receipt, valueMinor: estimate.valueMinor, currency: estimate.currency };
  }

  /**
   * Chronological credit statement for one user, plus balances and totals. Entries owed by
   * windows that closed since the last write are returned as `pending` without writing.
   */
  async ledger(userId: string, cursor?: string) {
    const row = await this.account(userId);
    const data = this.normalized(row?.data ?? {});
    const page = await this.store.list(LEDGER(userId), cursor);
    const pending = this.pendingWindows(row?.data, data).entries.map(({ seed, ...entry }) => ({ ...entry, source: "system", pending: true }));
    const entitlement = this.effective(data);
    const products = (entitlement.plan?.products ?? []).map((p: Product) => p.id);
    for (const productId of Object.keys(data.creditBalance ?? {})) if (!products.includes(productId)) products.push(productId);
    return {
      entries: page.items.map((r) => r.data),
      cursor: page.cursor,
      pending: cursor ? [] : pending,
      totals: { ...emptyTotals(), ...data.ledgerTotals, consumed: data.totalConsumed ?? 0 },
      balances: products.map((productId: string) => ({
        productId,
        allowanceLeft: this.allowanceLeft(data, productId),
        additionalCredits: data.creditBalance?.[productId] ?? 0,
        available: this.available(data, productId),
      })),
    };
  }

  /**
   * Subscription overview: customers, paying customers, projected monthly revenue per currency,
   * new and canceled subscriptions today, this month and per month. Records today's snapshot.
   */
  async overview(months = 12) {
    integer(months, 1, 36);
    const now = this.now(),
      today = dayKey(now),
      month = today.slice(0, 7);
    let customers = 0,
      paying = 0,
      canceling = 0;
    const mrrMinor: Record<string, number> = {},
      byPlan: Record<string, { name: string; customers: number; paying: number }> = {};
    let cursor: string | undefined;
    do {
      const page = await this.store.list("SUB_ACCOUNTS", cursor);
      for (const row of page.items) {
        const data = this.normalized(row.data);
        const entitlement = this.effective(data);
        if (!entitlement?.plan || entitlement.status !== "active" || now >= entitlement.periodEnd) continue;
        customers++;
        const plan = entitlement.plan as Plan;
        const summary = (byPlan[plan.id] ??= { name: plan.name, customers: 0, paying: 0 });
        summary.customers++;
        if (entitlement.cancelAtPeriodEnd) canceling++;
        // Paying: billed by the configured provider, a priced plan, and not ending this period.
        if (this.provider && entitlement.mode === this.provider.mode && plan.amount > 0) {
          paying++;
          summary.paying++;
          if (!entitlement.cancelAtPeriodEnd)
            mrrMinor[plan.currency] = (mrrMinor[plan.currency] ?? 0) + Math.round((plan.amount * 30) / plan.periodDays);
        }
      }
      cursor = page.cursor;
    } while (cursor);
    // One snapshot per day gives the historical customer line; later reads replace today's.
    const snapshotKey = "snap:" + today;
    const snapshot = { customers, paying, canceling, mrrMinor, at: now };
    await this.retry(async () => {
      const old = await this.store.get("SUB_STATS", snapshotKey);
      await this.store.transact([write(old, "SUB_STATS", snapshotKey, snapshot)]);
    });
    const days: Record<string, { new: number; canceled: number }> = {},
      snapshots: Record<string, any> = {};
    cursor = undefined;
    do {
      const page = await this.store.list("SUB_STATS", cursor);
      for (const row of page.items)
        if (row.sk.startsWith("day:")) days[row.sk.slice(4)] = { new: row.data.new ?? 0, canceled: row.data.canceled ?? 0 };
        else if (row.sk.startsWith("snap:")) snapshots[row.sk.slice(5)] = row.data;
      cursor = page.cursor;
    } while (cursor);
    const sum = (prefix: string, field: "new" | "canceled") =>
      Object.entries(days).filter(([d]) => d.startsWith(prefix)).reduce((n, [, v]) => n + v[field], 0);
    const series = Array.from({ length: months }, (_, i) => {
      const date = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - (months - 1 - i), 1));
      const key = date.toISOString().slice(0, 7);
      const last = Object.keys(snapshots).filter((d) => d.startsWith(key)).sort().at(-1);
      return {
        month: key,
        customers: last ? snapshots[last].customers : null,
        paying: last ? snapshots[last].paying : null,
        new: sum(key, "new"),
        canceled: sum(key, "canceled"),
      };
    });
    return {
      asOf: now,
      customers,
      paying,
      canceling,
      mrrMinor,
      plans: Object.entries(byPlan).map(([planId, v]) => ({ planId, ...v })),
      today: { date: today, new: days[today]?.new ?? 0, canceled: days[today]?.canceled ?? 0 },
      month: { month, new: sum(month, "new"), canceled: sum(month, "canceled") },
      series,
    };
  }

  async reset(userId: string, input: any, actorId: string) {
    const key = id(input.requestId),
      scope = input.scope;
    if (!["day", "week", "period", "all"].includes(scope))
      throw new HttpError(400, "Invalid reset scope");
    const reason = String(input.reason ?? "").trim();
    if (!reason || reason.length > 300)
      throw new HttpError(400, "A short courtesy reason is required");
    return this.retry(async () => {
      const op = await this.store.get("SUB_RESET#" + userId, key);
      if (op) {
        if (op.data.scope !== scope || op.data.reason !== reason)
          throw new Conflict();
        return { ok: true };
      }
      const row = await this.account(userId);
      if (!row || !this.effective(this.normalized(row.data)).plan) throw new HttpError(404, "No subscription");
      const data = this.normalized(row.data);
      const settled = this.settle(userId, row.data, data);
      const entries: Write[] = [];
      for (const [productId, c] of Object.entries(this.effective(data).counters) as [string, any][]) {
        const before = this.allowanceLeft(data, productId);
        for (const field of ["day", "week", "period"])
          if (scope === "all" || scope === field) c[field] = 0;
        const restored = this.allowanceLeft(data, productId) - before;
        entries.push(
          this.ledgerEntry(
            userId,
            data,
            { at: this.now(), kind: "reset", source: "admin", credits: restored, productId, reason: `Courtesy reset (${scope}) · ${reason}`, actorId, requestId: key },
            "reset:" + key + ":" + productId,
          ),
        );
      }
      const audit = { userId, actorId, scope, reason, at: this.now() };
      await this.store.transact([
        ...settled,
        ...entries,
        write(row, "SUB_ACCOUNTS", userId, {
          ...data,
          courtesyResets: (data.courtesyResets ?? 0) + 1,
        }),
        write(undefined, "SUB_RESET#" + userId, key, audit),
        write(undefined, "SUB_AUDIT", randomUUID(), {
          ...audit,
          action: "courtesy-reset",
        }),
      ]);
      return { ok: true };
    });
  }

  async publishPlan(planId: string, input: any, actorId: string) {
    if (!this.catalogFactory)
      throw new HttpError(503, "Stripe catalog is not configured");
    const publisher = this.catalogFactory(input?.secretKey || undefined);
    let row = await this.store.get("SUB_CONFIG", "settings");
    if (!row) throw new HttpError(409, "Save your plans first");
    let operation = row.data.catalogOperation;
    if (operation && operation.planId !== planId)
      throw new HttpError(409, "Resume the pending plan synchronization first");
    if (!operation) {
      if (input.version !== row.version) throw new Conflict();
      const plan = row.data.plans.find((p: Plan) => p.id === planId);
      if (!plan) throw new HttpError(404, "Plan not found");
      const last = await this.store.get("SUB_CATALOG_LAST", planId);
      operation = {
        id: randomUUID(),
        planId,
        plan,
        previous: last?.data.plan,
        actorId,
        at: this.now(),
      };
      await this.store.transact([
        write(row, "SUB_CONFIG", "settings", {
          ...row.data,
          catalogNamespace: row.data.catalogNamespace ?? randomUUID(),
          catalogOperation: operation,
        }),
      ]);
      row = (await this.store.get("SUB_CONFIG", "settings"))!;
    }
    // The persisted snapshot is immutable until publication finishes. Secrets are never persisted.
    const result = await publisher.publish(
      operation.plan,
      row.data.catalogNamespace,
      operation.previous,
    );
    const current = (await this.store.get("SUB_CONFIG", "settings"))!;
    if (!current.data.catalogOperation) return this.settings();
    if (current.data.catalogOperation.id !== operation.id) throw new Conflict();
    const plan = { ...operation.plan, ...result, stripeManaged: true };
    const last = await this.store.get("SUB_CATALOG_LAST", planId);
    const price = await this.store.get("SUB_PLAN_PRICES", result.stripePriceId);
    await this.store.transact([
      write(current, "SUB_CONFIG", "settings", {
        ...current.data,
        catalogOperation: undefined,
        plans: current.data.plans.map((p: Plan) =>
          p.id === planId ? plan : p,
        ),
      }),
      write(last, "SUB_CATALOG_LAST", planId, { plan }),
      write(price, "SUB_PLAN_PRICES", result.stripePriceId, { plan }),
      write(undefined, "SUB_AUDIT", randomUUID(), {
        action: "publish-plan",
        planId,
        version: plan.version,
        actorId,
        at: this.now(),
      }),
    ]);
    return this.settings();
  }

  async grant(userId: string, input: any, actorId: string) {
    const key = id(input.requestId),
      kind = input.kind;
    if (!["plan", "credits"].includes(kind))
      throw new HttpError(400, "Invalid assignment type");
    const reason = String(input.reason ?? "").trim();
    if (!reason || reason.length > 300)
      throw new HttpError(400, "A short reason is required");
    const currency = String(input.currency ?? "").toLowerCase();
    if (!validCurrency(currency)) throw new HttpError(400, "Invalid currency");
    const valueMinor = integer(input.valueMinor, 0);
    if (!validMinorAmount(valueMinor, currency))
      throw new HttpError(400, "Invalid amount for currency");
    const target = id(kind === "plan" ? input.planId : input.productId);
    const credits = kind === "credits" ? integer(input.credits, 1) : 0;
    const fingerprint = JSON.stringify({
      kind,
      target,
      credits,
      valueMinor,
      currency,
      reason,
      actorId,
    });
    return this.retry(async () => {
      const prior = await this.store.get("SUB_GRANTS#" + userId, key);
      if (prior) {
        if (prior.data.fingerprint !== fingerprint) throw new Conflict();
        return { ok: true };
      }
      const user = await this.store.get("USERS", userId);
      if (!user || user.data.deletedAt)
        throw new HttpError(404, "User not found");
      const settings = await this.settings();
      const plan = settings.values.plans.find((p) => p.id === target);
      if (kind === "plan" && !plan) throw new HttpError(404, "Plan not found");
      if (
        kind === "credits" &&
        !settings.values.plans.some((p) =>
          p.products.some((x) => x.id === target),
        )
      )
        throw new HttpError(404, "Product not found");
      const row = await this.account(userId);
      const data = this.normalized({
        ...row?.data,
        userId,
        email: user.data.email,
      });
      const at = this.now();
      if (kind === "plan")
        data.adminGrant = {
          plan,
          mode: "admin",
          status: "active",
          periodStart: at,
          periodEnd: at + plan!.periodDays * 86400000,
          counters: {},
          actorId,
          reason,
          valueMinor,
          currency,
        };
      if (data.adminGrant) data.adminGrant = this.normalized(data.adminGrant);
      if (kind !== "plan") {
        data.creditBalance ??= {};
        data.creditBalance[target] = integer(
          (data.creditBalance[target] ?? 0) + credits,
          0,
        );
      }
      const audit = {
        kind,
        target,
        credits,
        valueMinor,
        currency,
        reason,
        actorId,
        userId,
        at,
        source: "admin",
        fingerprint,
      };
      const wasActive = Boolean(this.windows(this.normalized({ ...row?.data })));
      const settled = this.settle(userId, row?.data, data);
      const entry = this.ledgerEntry(
        userId,
        data,
        {
          at,
          kind: kind === "plan" ? "plan" : "grant",
          source: "admin",
          credits,
          ...(kind === "plan" ? { planId: target } : { productId: target }),
          reason: (kind === "plan" ? "Plan assigned by administrator: " + plan!.name : "Credits assigned by administrator") + " · " + reason,
          actorId,
          requestId: key,
          ...(valueMinor ? { amountMinor: valueMinor, currency } : {}),
        },
        "grant:" + key,
      );
      await this.store.transact([
        write(row, "SUB_ACCOUNTS", userId, data),
        write(undefined, "SUB_GRANTS#" + userId, key, audit),
        entry,
        ...settled,
        ...(kind === "plan" && !wasActive ? [await this.statsWrite("new")] : []),
      ]);
      return { ok: true };
    });
  }

  async listUsers(query: Record<string, string | undefined>) {
    const q = String(query.q ?? "")
      .trim()
      .toLowerCase();
    if (q.length > 200) throw new HttpError(400, "Search is too long");
    // One bounded storage page per request; next cursor continues searching.
    const page = await this.store.list("USERS", query.cursor);
    const users = page.items.filter(
      (r) =>
        !r.data.deletedAt &&
        (!q ||
          [r.sk, r.data.email, r.data.name].some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(q),
          )),
    );
    const items = await Promise.all(
      users.map(async (r) => {
        const row = await this.account(r.sk);
        const base = this.normalized(row?.data ?? {});
        const data = this.effective(base);
        const products = new Set<string>([
          ...(data.plan?.products ?? []).map((p: Product) => p.id),
          ...Object.keys(base.creditBalance ?? {}),
        ]);
        return {
          creditsAvailable: [...products].reduce((n, productId) => n + this.available(base, productId), 0),
          userId: r.sk,
          email: r.data.email,
          name: r.data.name,
          plan: data.plan?.name,
          status: data.status ?? "none",
          source: data.mode,
          totalConsumed: row?.data.totalConsumed ?? 0,
          courtesyResets: row?.data.courtesyResets ?? 0,
        };
      }),
    );
    return { items, cursor: page.cursor };
  }

  async webhook(raw: string, signature: string) {
    if (!this.provider) throw new HttpError(503, "Payments not configured");
    let event;
    try {
      event = this.provider.verify(raw, signature);
    } catch {
      throw new HttpError(400, "Invalid webhook signature");
    }
    if (
      !event.customer ||
      ![
        "invoice.payment_failed",
        "invoice.paid",
        "invoice.upcoming",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.trial_will_end",
      ].includes(event.type)
    )
      return { ok: true };
    const seen = await this.store.get("SUB_EVENTS", event.id);
    if (seen) return { ok: true };
    const mapping = await this.store.get("SUB_CUSTOMERS", event.customer);
    if (!mapping) throw new HttpError(409, "Customer mapping not ready");
    await this.sync(mapping.data.userId);
    const row = await this.account(mapping.data.userId),
      settings = await this.settings();
    const notify =
      settings.values.notifications &&
      row?.data.notifications !== false &&
      [
        "invoice.payment_failed",
        "invoice.paid",
        "invoice.upcoming",
        "customer.subscription.deleted",
        "customer.subscription.trial_will_end",
      ].includes(event.type);
    await this.store
      .transact([
        write(undefined, "SUB_EVENTS", event.id, {
          type: event.type,
          at: this.now(),
        }),
        ...(notify
          ? [
              write(undefined, "SUB_MAIL", event.id, {
                userId: mapping.data.userId,
                to: row!.data.email,
                subject: "Subscription update",
                text: event.type.replaceAll(".", " · "),
                sent: false,
              }),
            ]
          : []),
      ])
      .catch(async (e) => {
        if (
          !(e instanceof Conflict) ||
          !(await this.store.get("SUB_EVENTS", event.id))
        )
          throw e;
      });
    return { ok: true };
  }

  async maintenance() {
    const settings = await this.settings();
    const checkpoint = await this.store.get("SUB_MAINTENANCE", "cursor");
    let cursor: string | undefined = checkpoint?.data.accounts;
    let processed = 0;
    const deadline = Date.now() + 15000;
    do {
      const page = await this.store.list("SUB_ACCOUNTS", cursor);
      for (const row of page.items) {
        const d = row.data;
        if (!d.plan) continue;
        const renew = d.mode === "none" && !d.cancelAtPeriodEnd && this.now() >= d.periodEnd;
        const periods = renew
          ? Math.floor((this.now() - d.periodStart) / (d.plan.periodDays * 86400000))
          : 0;
        const next = this.normalized(
          renew
            ? {
                ...d,
                periodStart: d.periodStart + periods * d.plan.periodDays * 86400000,
                periodEnd: d.periodStart + (periods + 1) * d.plan.periodDays * 86400000,
                counters: {},
              }
            : d,
        );
        // Record closed weekly windows (expiry and new allowance) even for idle accounts.
        const settled = this.settle(row.sk, d, next);
        if (renew || settled.length)
          await this.store
            .transact([write(row, row.pk, row.sk, next), ...settled])
            .catch((e) => {
              if (!(e instanceof Conflict)) throw e;
            });
        if (
          settings.values.notifications &&
          d.notifications !== false &&
          d.email &&
          d.periodEnd - this.now() <= settings.values.reminderDays * 86400000 &&
          d.periodEnd > this.now()
        ) {
          const key = d.userId + "-" + d.periodEnd;
          if (!(await this.store.get("SUB_MAIL", key)))
            await this.store
              .transact([
                write(undefined, "SUB_MAIL", key, {
                  userId: d.userId,
                  to: d.email,
                  subject: "Subscription period ending",
                  text:
                    "Your current subscription period ends on " +
                    new Date(d.periodEnd).toISOString(),
                  sent: false,
                }),
              ])
              .catch((e) => {
                if (!(e instanceof Conflict)) throw e;
              });
        }
      }
      cursor = page.cursor;
      processed += page.items.length;
    } while (cursor && processed < 100 && Date.now() < deadline);
    let mailCursor: string | undefined = checkpoint?.data.mail;
    if (this.notify && Date.now() < deadline) {
      const startMailCursor = mailCursor;
      const mails = await this.store.list("SUB_MAIL", mailCursor);
      mailCursor = mails.cursor;
      for (const row of mails.items) {
        if (Date.now() >= deadline) {
          mailCursor = startMailCursor;
          break;
        }
        if (
          row.data.sent ||
          row.data.lockUntil > this.now() ||
          !settings.values.notifications
        )
          continue;
        if (
          row.data.userId &&
          (await this.account(row.data.userId))?.data.notifications === false
        )
          continue;
        const claim = write(row, row.pk, row.sk, {
          ...row.data,
          lockUntil: this.now() + 60000,
        });
        try {
          await this.store.transact([claim]);
        } catch (e) {
          if (e instanceof Conflict) continue;
          throw e;
        }
        try {
          await this.notify({
            to: row.data.to,
            subject: row.data.subject,
            text: row.data.text,
          });
          await this.store.transact([
            write(claim.row, row.pk, row.sk, { ...claim.row.data, sent: true }),
          ]);
        } catch {
          /* Leave durable notice for retry after the lease expires. */
        }
      }
    }
    await this.store
      .transact([
        write(checkpoint, "SUB_MAINTENANCE", "cursor", {
          accounts: cursor ?? null,
          mail: mailCursor ?? null,
        }),
      ])
      .catch((e) => {
        if (!(e instanceof Conflict)) throw e;
      });
    return { processed, partial: !!cursor || !!mailCursor };
  }

  /** HTTP endpoints, admin UI and agent-facing actions for this module. */
  feature(): Feature {
    return {
      id: "subscriptions",
      migrations: [schemaMigration("subscriptions")],
      admin: {
        id: "subscriptions",
        title: "Subscriptions",
        resource: "subscriptions.manage",
        path: "/subscriptions/admin/accounts",
        component: "subscriptions",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        ...["create", "update", "archive", "unarchive", "version"].map(
          (action) => ({
            method: "POST",
            path: `/subscriptions/admin/plans/actions/${action}`,
            resource: "subscriptions.manage",
            access: "owner" as const,
            tool: {
              name: `subscriptions_plan_${action}`,
              description: `${action} a plan. Read settings first; body.version is its concurrency revision. Body.id selects an existing plan. Create/update accept body.plan (name, amount, currency, periodDays, products). Product entries define id, name, credits, dailyLimit, weeklyLimit, daySeconds, weekSeconds. Create generates ID and starts disabled. Archive/unarchive leave disabled. Version snapshots even unchanged content. Publish separately to synchronize Stripe.`,
              example: { body: { version: 0, id: "pro" } },
            },
            handle: (c: import("@gsalgadotoledo/rt-app-contracts").Context) =>
              this.editPlan(action, c.request.body, c.actor!.id),
          }),
        ),
        {
          method: "GET",
          path: "/subscriptions/me",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.me(c.actor!.id),
        },
        {
          method: "GET",
          path: "/subscriptions/billing",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.billing(c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/change",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) =>
            this.change(
              c.actor!,
              String(c.request.body.planId),
              id(c.request.body.requestId),
            ),
        },
        {
          method: "POST",
          path: "/subscriptions/payment/setup",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) =>
            this.setupPayment(c.actor!, id(c.request.body.requestId)),
        },
        {
          method: "POST",
          path: "/subscriptions/payment/save",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.setPayment(c.actor!, id(c.request.body.setupId)),
        },
        {
          method: "POST",
          path: "/subscriptions/cancel",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.cancel(c.actor!, id(c.request.body.requestId)),
        },
        {
          method: "POST",
          path: "/subscriptions/sync",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: async (c) => {
            await this.sync(c.actor!.id);
            return this.me(c.actor!.id);
          },
        },
        {
          method: "PUT",
          path: "/subscriptions/preferences",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) =>
            this.preferences(c.actor!.id, c.request.body.notifications),
        },
        {
          method: "POST",
          path: "/subscriptions/webhook",
          resource: "subscriptions.webhook",
          access: "guest",
          handle: (c) =>
            this.webhook(
              c.request.rawBody ?? "",
              c.request.headers["stripe-signature"] ?? "",
            ),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/settings",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_settings_get",
            description:
              "Read settings and optimistic concurrency version. Read before editing plans.",
            example: {},
          },
          handle: () => this.settings(),
        },
        {
          method: "PUT",
          path: "/subscriptions/admin/settings",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_settings_save",
            description:
              "Save complete settings with version. Add plans, edit products/prices/limits, or set archived:true and enabled:false. Changed plan content creates a version; preserve all existing plan IDs.",
            example: { body: { version: 0, values: {} } },
          },
          handle: (c) => this.saveSettings(c.request.body, c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/plans/:id/publish",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_plan_publish",
            description:
              "Synchronize a saved plan to Stripe. Creates paid catalog resources; requires configured Stripe credentials. Body: version.",
            example: { params: { id: "pro" }, body: { version: 1 } },
          },
          handle: (c) =>
            this.publishPlan(c.params.id, c.request.body, c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/plans/:id/restore",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_plan_restore",
            description:
              "Restore history as a new version. Body: version (settings revision), fromVersion (plan version).",
            example: {
              params: { id: "pro" },
              body: { version: 1, fromVersion: "0.0.1" },
            },
          },
          handle: (c) =>
            this.restorePlan(c.params.id, c.request.body, c.actor!.id),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/plans/:id/history",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_plan_history",
            description: "Read paginated plan history; optional query.cursor.",
            example: { params: { id: "pro" } },
          },
          handle: (c) =>
            this.store.list(
              "SUB_PLAN_HISTORY#" + c.params.id,
              c.request.query.cursor,
            ),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/accounts",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_accounts_list",
            description:
              "Search users one page at a time; optional query.q and query.cursor.",
            example: {},
          },
          handle: (c) => this.listUsers(c.request.query),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/accounts/:id",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_get",
            description:
              "Read account, invoices, grants and usage. params.id identifies the user.",
            example: { params: { id: "USER_ID" } },
          },
          handle: async (c) => ({
            account: {
              ...(await this.me(c.params.id)),
              email: (await this.store.get("USERS", c.params.id))?.data.email,
            },
            billing: await this.billing(c.params.id),
            grants: await this.store.list(
              "SUB_GRANTS#" + c.params.id,
              c.request.query.historyCursor,
            ),
            usage: await this.store.list(
              "SUB_USAGE#" + c.params.id,
              c.request.query.cursor,
            ),
          }),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/overview",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_overview",
            description:
              "Customers, paying customers, projected monthly revenue per currency (minor units), new and canceled subscriptions today, this month and per month. query.months (1-36, default 12).",
            example: { query: { months: "12" } },
          },
          handle: (c) => this.overview(c.request.query.months ? Number(c.request.query.months) : 12),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/accounts/:id/ledger",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_ledger",
            description:
              "Chronological credit statement (allowances, usage, expiries, grants, purchases, plans), balances and totals. params.id user; query.cursor continues.",
            example: { params: { id: "USER_ID" } },
          },
          handle: (c) => this.ledger(c.params.id, c.request.query.cursor),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/ledger",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_record",
            description:
              "Record a credit (+) or debit (−) on the user's statement. Body: requestId, productId, credits (non-zero integer), kind (purchase|adjustment|grant|usage), reason, optional amountMinor+currency for money paid, details. Debits use the plan allowance first. Reuse requestId for retries.",
            example: {
              params: { id: "USER_ID" },
              body: { requestId: "unique-request-id", productId: "api", credits: 1000, kind: "purchase", reason: "Top-up", amountMinor: 1000, currency: "usd" },
            },
          },
          handle: (c) => {
            const body = c.request.body;
            return this.recordCredits(c.params.id, {
              requestId: body.requestId,
              productId: body.productId,
              credits: body.credits,
              kind: body.kind,
              reason: body.reason,
              amountMinor: body.amountMinor,
              currency: body.currency,
              details: body.details && typeof body.details === "object" && !Array.isArray(body.details)
                ? Object.fromEntries(Object.entries(body.details).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, 200)]))
                : undefined,
              source: "admin",
              actorId: c.actor!.id,
            });
          },
        },
        {
          method: "POST",
          path: "/subscriptions/admin/credits/estimate",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_estimate",
            description:
              "Credit sandbox: price a request by rate (model) and tokens; with userId shows how it would be charged. Body: rateId, inputTokens, outputTokens, optional userId, productId. Never writes.",
            example: { body: { rateId: "standard", inputTokens: 1000, outputTokens: 500 } },
          },
          handle: (c) => this.estimate(c.request.body as any),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/grant",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_grant",
            description:
              "Assign plan or credits without charging a card. Body: requestId,kind(plan|credits),planId or productId,credits,valueMinor,currency,reason. Reuse requestId for retries.",
            example: {
              params: { id: "USER_ID" },
              body: {
                kind: "credits",
                productId: "api",
                credits: 100,
                valueMinor: 100,
                currency: "usd",
                reason: "Courtesy",
                requestId: "unique-request-id",
              },
            },
          },
          handle: (c) => this.grant(c.params.id, c.request.body, c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/reset",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_reset",
            description:
              "Reset usage window. Body: requestId,scope(day|week|period|all),reason.",
            example: {
              params: { id: "USER_ID" },
              body: {
                requestId: "unique-request-id",
                scope: "day",
                reason: "Courtesy",
              },
            },
          },
          handle: (c) => this.reset(c.params.id, c.request.body, c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/simulate",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_account_simulate",
            description:
              "Local billing only: simulate payment status. params.id and body.status required.",
          },
          handle: async (c) => {
            if (!this.provider?.simulate)
              throw new HttpError(404, "Simulation unavailable");
            const row = await this.account(c.params.id);
            if (!row?.data.customerId)
              throw new HttpError(404, "No simulated customer");
            await this.provider.simulate(
              row.data.customerId,
              c.request.body.status,
            );
            await this.sync(c.params.id);
            return { ok: true };
          },
        },
        {
          method: "POST",
          path: "/subscriptions/admin/maintenance",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_maintenance",
            description:
              "Run subscription maintenance and configured notifications.",
            example: {},
          },
          handle: () => this.maintenance(),
        },
      ],
    };
  }
}

export { LocalBilling } from "./local.js";
