import { planIdFromName } from "./plan-id.js";
import { validCurrency, validMinorAmount } from "./currency.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  Conflict,
  schemaMigration,
  type Actor,
  type Context,
  type Endpoint,
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
import {
  MAX_ACTIVE_RESERVATIONS,
  RESERVATIONS,
  activeHolds,
  reservationKey,
  reservationReason,
  reservationTtl,
  sameUsage,
  settleUsage,
  windowUsage,
  thresholdOf,
  type Hold,
  type ReservationMeta,
  type ReserveInput,
  type SettleUsage,
} from "./reservations.js";
export * from "./reservations.js";
export interface Product {
  id: string;
  name: string;
  credits: number;
  dailyLimit: number;
  weeklyLimit: number;
  daySeconds: number;
  weekSeconds: number;
  /** Optional short window (e.g. 5 hours): at most `shortLimit` plan credits per `shortSeconds`. */
  shortLimit?: number;
  shortSeconds?: number;
  /** Optional per-model caps (credits of one rate per window); read live from the settings. */
  rateCaps?: RateCap[];
}
/**
 * Credits of one rate (model) a user may spend per window, all sources included. Windows are
 * the product's: short (needs the product's short window), day, week and period.
 */
export interface RateCap {
  rateId: string;
  short?: number;
  day?: number;
  week?: number;
  period?: number;
}
export const CAP_WINDOWS = ["short", "day", "week", "period"] as const;
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
  /**
   * Margin rule: the most provider cost (minor units of the credit pack currency, which must be
   * the plan currency) one user of this plan should cause per period. Read live from settings.
   */
  maxProviderCostMinor?: number;
}
/** Credits charged per model/function; decimals allowed (e.g. 0.25 credits per 1k tokens). */
export interface CreditRate {
  id: string;
  name: string;
  inputPer1k: number;
  outputPer1k: number;
  /** Minimum credits charged per request. */
  minimum: number;
  /**
   * What the provider charges us, in minor units of the pack currency per 1k tokens (up to 4
   * decimals). Optional: rates without it cost 0 in the unit economics and margin rules.
   */
  costInputPer1k?: number;
  costOutputPer1k?: number;
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
/**
 * Non-negative rate with at most 4 decimals, so estimates are reproducible. The decimal check
 * tolerates float64 noise: 0.57 * 1e4 is 5699.999999999999, and 0.57 is a valid rate.
 */
const rate = (n: unknown) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e6 || Math.abs(n * 1e4 - Math.round(n * 1e4)) > 1e-6)
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
    ...(r.costInputPer1k != null || r.costOutputPer1k != null
      ? { costInputPer1k: rate(r.costInputPer1k ?? 0), costOutputPer1k: rate(r.costOutputPer1k ?? 0) }
      : {}),
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
    maxProviderCostMinor: p.maxProviderCostMinor,
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
    ...(p.maxProviderCostMinor != null ? { maxProviderCostMinor: p.maxProviderCostMinor } : {}),
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
            // Validated by `validateLimits` once the credit rates are known.
            ...(x.shortLimit != null || x.shortSeconds != null ? { shortLimit: x.shortLimit, shortSeconds: x.shortSeconds } : {}),
            ...(x.rateCaps != null ? { rateCaps: x.rateCaps } : {}),
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
  const reminderDays = integer(input.reminderDays, 0, 30);
  // Settings saved before credit rates existed keep working with the defaults.
  const credits = validateCredits(input.credits ?? defaults.credits);
  validateLimits(plans, credits);
  return {
    paymentRequired: input.paymentRequired,
    notifications: input.notifications,
    reminderDays,
    plans,
    credits,
  };
}

const capValue = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1e9;

/**
 * Finance limits, checked after the rates (in plan, then product order): the short window
 * (shortLimit 0..1e9 and shortSeconds 60..604800, both or neither: 400 "Invalid short window"),
 * model caps (at most 20, known and distinct rate ids, windows short|day|week|period as
 * integers 0..1e9, at least one, short only with a short window: 400 "Invalid model cap"; an
 * empty list is dropped) and the margin rule (maxProviderCostMinor integer 0..1e12 and the plan
 * currency equal to the credit pack currency: 400 "Invalid margin rule"). Mutates `plans`.
 */
function validateLimits(plans: Plan[], credits: CreditSettings) {
  for (const plan of plans) {
    for (const product of plan.products) {
      if (product.shortLimit !== undefined || product.shortSeconds !== undefined) {
        const seconds = product.shortSeconds;
        if (!capValue(product.shortLimit) || !Number.isSafeInteger(seconds) || seconds! < 60 || seconds! > 604800)
          throw new HttpError(400, "Invalid short window");
      }
      if (product.rateCaps !== undefined) {
        const raw: any = product.rateCaps;
        if (!Array.isArray(raw) || raw.length > 20) throw new HttpError(400, "Invalid model cap");
        const caps: RateCap[] = raw.map((c: any) => {
          if (!c || typeof c !== "object" || Array.isArray(c) || !credits.rates.some((r) => r.id === c.rateId))
            throw new HttpError(400, "Invalid model cap");
          const cap: RateCap = { rateId: c.rateId };
          for (const w of CAP_WINDOWS) {
            if (c[w] === undefined || c[w] === null) continue;
            if (!capValue(c[w]) || (w === "short" && product.shortSeconds === undefined)) throw new HttpError(400, "Invalid model cap");
            cap[w] = c[w];
          }
          if (Object.keys(cap).length < 2) throw new HttpError(400, "Invalid model cap");
          return cap;
        });
        if (new Set(caps.map((c) => c.rateId)).size !== caps.length) throw new HttpError(400, "Invalid model cap");
        if (caps.length) product.rateCaps = caps;
        else delete product.rateCaps;
      }
    }
    if (plan.maxProviderCostMinor !== undefined) {
      const max: unknown = plan.maxProviderCostMinor;
      if (!Number.isSafeInteger(max) || (max as number) < 0 || (max as number) > 1e12 || plan.currency !== credits.pack.currency)
        throw new HttpError(400, "Invalid margin rule");
    }
  }
}

/** Ledger `details` from a request: at most 20 entries, keys cut to 40, strings cut to 200. */
const ledgerDetails = (details: any) =>
  details && typeof details === "object" && !Array.isArray(details)
    ? Object.fromEntries(
        Object.entries(details)
          .slice(0, 20)
          .map(([k, v]) => [String(k).slice(0, 40), typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, 200)]),
      )
    : undefined;

/** Request bodies of the reservation endpoints: only the documented fields reach the service. */
const amountBody = (body: any) => ({ credits: body.credits, estimate: body.estimate });
const reserveBody = (body: any): ReserveInput => ({
  key: body.key,
  credits: body.credits,
  estimate: body.estimate,
  ttlMs: body.ttlMs,
  reason: body.reason,
});
const usageBody = (body: any) => ({ credits: body.credits, inputTokens: body.inputTokens, outputTokens: body.outputTokens }) as SettleUsage;

/** Zero one window of every per-model counter (`counters[productId].rates[rateId][window]`). */
function resetRateWindow(c: any, window: string) {
  for (const r of Object.values(c.rates ?? {}) as any[]) if (r[window] !== undefined) r[window] = 0;
}
/** Math.round to 4 decimals: provider costs are kept in minor units with 4 decimals. */
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Credits of token usage at a rate: rounded up (tolerating float noise), at least the minimum. */
export function rateCredits(rate: CreditRate, inputTokens: number, outputTokens: number) {
  const exact = (inputTokens / 1000) * rate.inputPer1k + (outputTokens / 1000) * rate.outputPer1k;
  return { exact, credits: Math.max(rate.minimum, Math.ceil(Math.round(exact * 1e6) / 1e6)) };
}

/** Provider cost of token usage at a rate (minor units, 4 decimals); null when the rate has none. */
export function providerCost(rate: CreditRate, inputTokens: number, outputTokens: number): number | null {
  if (rate.costInputPer1k === undefined) return null;
  return round4((inputTokens / 1000) * rate.costInputPer1k + (outputTokens / 1000) * (rate.costOutputPer1k ?? 0));
}

/** The first window a charge of `credits` would overflow (used + reserved + credits > limit), or null. */
export function exceededWindow(windows: { kind: string; used: number; reserved: number; limit: number }[], credits: number) {
  return windows.find((w) => w.used + w.reserved + credits > w.limit)?.kind ?? null;
}

const modelLimit = (rateName: string, window: string) =>
  new HttpError(429, `Model limit reached: ${rateName} ${window} limit. Use another model or wait for the reset.`);

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

  /**
   * Attach Stripe ids created outside the app (e.g. by infra/stripe with Terraform) to plans.
   * Plan content and versions do not change; returns the ids of the plans that changed.
   * @example await subscriptions.linkStripePrices({ pro: { productId: "prod_1", priceId: "price_1" } }, "terraform")
   */
  async linkStripePrices(
    links: Record<string, { productId: string; priceId: string }>,
    actorId: string,
  ) {
    const old = await this.store.get("SUB_CONFIG", "settings");
    if (old?.data.catalogOperation)
      throw new HttpError(409, "Resume the pending Stripe synchronization before linking prices");
    const plans: Plan[] = old?.data.plans ?? structuredClone(defaults.plans);
    for (const [planId, ids] of Object.entries(links)) {
      if (!plans.some((p) => p.id === planId)) throw new HttpError(404, "Plan not found: " + planId);
      if (!/^prod_[A-Za-z0-9]{1,250}$/.test(ids?.productId) || !/^price_[A-Za-z0-9]{1,250}$/.test(ids?.priceId))
        throw new HttpError(400, "Invalid Stripe ids for " + planId);
    }
    const linked = plans.filter(
      (p) => links[p.id] && (p.stripePriceId !== links[p.id].priceId || p.stripeProductId !== links[p.id].productId),
    );
    if (!linked.length) return [];
    const taken = new Set(plans.filter((p) => !links[p.id]).map((p) => p.stripePriceId).filter(Boolean));
    if (linked.some((p) => taken.has(links[p.id].priceId)) || new Set(Object.values(links).map((l) => l.priceId)).size !== Object.keys(links).length)
      throw new HttpError(400, "A Stripe price can belong to one plan only");
    await this.store.transact([
      write(old ?? undefined, "SUB_CONFIG", "settings", {
        ...(old?.data ?? structuredClone(defaults)),
        plans: plans.map((p) =>
          links[p.id] ? { ...p, stripeProductId: links[p.id].productId, stripePriceId: links[p.id].priceId } : p,
        ),
      }),
      write(undefined, "SUB_AUDIT", randomUUID(), {
        action: "link-stripe-prices",
        plans: linked.map((p) => p.id),
        actorId,
        at: this.now(),
      }),
    ]);
    return linked.map((p) => p.id);
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
          resetRateWindow(c, window);
        }
      }
      // The short window starts with the first use after the previous one ended (like the
      // 5-hour window of chat products), not on a fixed grid.
      if (p.shortSeconds !== undefined && (c.shortStart === undefined || now >= c.shortStart + p.shortSeconds * 1000)) {
        c.short = 0;
        c.shortStart = now;
        resetRateWindow(c, "short");
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
    const short = product.shortSeconds !== undefined ? product.shortLimit! - (c.short ?? 0) : Infinity;
    return Math.max(0, Math.min(product.dailyLimit - c.day, product.weeklyLimit - c.week, product.credits - c.period, short));
  }

  /** Credits held by active (unexpired) reservations of a product. */
  private held(data: any, productId: string) {
    return activeHolds(data.reservations, this.now())
      .filter((h) => h.productId === productId)
      .reduce((n, h) => n + h.credits, 0);
  }

  /**
   * What a new charge can use, net of active holds: spendable = max(0, allowance + balance −
   * held), taken from the plan allowance first. Holds never push a charge onto additional
   * credits (which do not expire) while the allowance can pay it and every hold stays covered.
   * @example allowance 100, balance 10, held 60 → {allowance: 50, balance: 0}
   */
  private free(data: any, productId: string) {
    const allowance = this.allowanceLeft(data, productId);
    const balance = data.creditBalance?.[productId] ?? 0;
    const held = this.held(data, productId);
    const spendable = Math.max(0, allowance + balance - held);
    const fromAllowance = Math.min(allowance, spendable);
    return { allowance: fromAllowance, balance: spendable - fromAllowance, held, rawAllowance: allowance, rawBalance: balance };
  }

  /** Credits usable now for a product: plan allowance plus additional credits, minus active holds. */
  private available(data: any, productId: string) {
    const free = this.free(data, productId);
    return free.allowance + free.balance;
  }

  /**
   * Why an account cannot be charged for a product now, or null: "inactive" (no active,
   * unexpired entitlement), "payment" (payments required and the entitlement is not paid),
   * "product" (the plan does not include it; skipped without a product).
   */
  private blocked(data: any, productId: string | undefined, paymentRequired: boolean) {
    const entitlement = this.effective(data);
    if (!entitlement?.plan || entitlement.status !== "active" || this.now() >= entitlement.periodEnd) return "inactive";
    if (paymentRequired && entitlement.mode !== "admin" && entitlement.mode !== this.provider?.mode) return "payment";
    if (productId !== undefined && !entitlement.plan.products.some((p: Product) => p.id === productId)) return "product";
    return null;
  }

  /** The entitlement and product a charge uses; 402 inactive or unpaid, 403 product not in the plan. */
  private async chargeable(data: any, productId: string) {
    const reason = this.blocked(data, productId, (await this.settings()).values.paymentRequired);
    if (reason === "inactive") throw new HttpError(402, "Subscription is inactive or expired");
    if (reason === "payment") throw new HttpError(402, "A paid subscription is required");
    if (reason === "product") throw new HttpError(403, "Product is not included in your plan");
    const entitlement = this.effective(data);
    return { entitlement, product: entitlement.plan.products.find((p: Product) => p.id === productId) as Product };
  }

  // -------------------------------------------------------------------------
  // Finance limits: per-model caps, provider costs and the margin rule. Caps and the margin cap
  // are read live from the settings (the plan with the entitlement's plan id), so an operator can
  // tighten them without a deploy or a migration; the windows keep the plan as subscribed.
  // See docs/polyglot/subscriptions-limits.md.
  // -------------------------------------------------------------------------

  /** The active entitlement or undefined (no plan, not active or past its period). */
  private active(data: any) {
    const entitlement = this.effective(data);
    return entitlement?.plan && entitlement.status === "active" && this.now() < entitlement.periodEnd ? entitlement : undefined;
  }

  /** The cap of a rate for a product of the active entitlement, from the current settings. */
  private rateCap(data: any, values: Settings, productId: string, rateId: string | undefined): RateCap | undefined {
    const entitlement = rateId === undefined ? undefined : this.active(data);
    if (!entitlement) return undefined;
    const plan: Plan = values.plans.find((p) => p.id === entitlement.plan.id) ?? entitlement.plan;
    return plan.products.find((p) => p.id === productId)?.rateCaps?.find((c) => c.rateId === rateId);
  }

  /** Every cap of a product of the active entitlement, from the current settings. */
  private rateCaps(data: any, values: Settings, productId: string): RateCap[] {
    const entitlement = this.active(data);
    if (!entitlement) return [];
    const plan: Plan = values.plans.find((p) => p.id === entitlement.plan.id) ?? entitlement.plan;
    return plan.products.find((p) => p.id === productId)?.rateCaps ?? [];
  }

  /**
   * Usage of a capped rate per window (the cap's windows, in the order short, day, week,
   * period; short only when the subscribed product has a short window), with the active holds of
   * that rate as `reserved`. [] without a cap.
   */
  private rateWindows(data: any, productId: string, cap: RateCap | undefined) {
    const entitlement = cap && this.active(data);
    const product: Product | undefined = entitlement?.plan.products.find((p: Product) => p.id === productId);
    const c = entitlement?.counters?.[productId];
    if (!cap || !product || !c) return [];
    const used = c.rates?.[cap.rateId] ?? {};
    const reserved = activeHolds(data.reservations, this.now())
      .filter((h) => h.productId === productId && h.rateId === cap.rateId)
      .reduce((n, h) => n + h.credits, 0);
    const resetAt: Record<string, number> = {
      short: c.shortStart + (product.shortSeconds ?? 0) * 1000,
      day: c.dayStart + product.daySeconds * 1000,
      week: c.weekStart + product.weekSeconds * 1000,
      period: entitlement.periodEnd,
    };
    return CAP_WINDOWS.filter((w) => cap[w] !== undefined && (w !== "short" || product.shortSeconds !== undefined)).map((w) =>
      windowUsage(w, used[w] ?? 0, reserved, cap[w]!, resetAt[w]),
    );
  }

  /** Count credits used at a capped rate on every window of the product (short only with one). */
  private countRate(data: any, productId: string, cap: RateCap | undefined, credits: number) {
    const entitlement = cap && credits > 0 ? this.active(data) : undefined;
    const product: Product | undefined = entitlement?.plan.products.find((p: Product) => p.id === productId);
    const c = entitlement?.counters?.[productId];
    if (!cap || !product || !c) return;
    c.rates ??= {};
    const r = (c.rates[cap.rateId] ??= {});
    for (const w of CAP_WINDOWS) if (w !== "short" || product.shortSeconds !== undefined) r[w] = (r[w] ?? 0) + credits;
  }

  /** Add provider cost (minor units of `currency`) to the account: all-time per currency and this period. */
  private addCost(data: any, cost: number | null | undefined, currency: string) {
    if (!(typeof cost === "number" && cost > 0)) return;
    const start = this.effective(data)?.periodStart ?? null;
    const c = (data.providerCost ??= { totalMinor: {}, periodStart: start, periodMinor: 0 });
    if (c.periodStart !== start) {
      c.periodStart = start;
      c.periodMinor = 0;
    }
    c.periodMinor = round4(c.periodMinor + cost);
    c.totalMinor[currency] = round4((c.totalMinor[currency] ?? 0) + cost);
  }

  /** Provider cost of the current entitlement period (0 when none was recorded in it). */
  private periodCost(data: any): number {
    const c = data.providerCost;
    return c && c.periodStart === (this.effective(data)?.periodStart ?? null) ? c.periodMinor : 0;
  }

  /**
   * The margin rule of the active entitlement or null: provider cost of this period against the
   * plan's maxProviderCostMinor (live), percent = floor(cost * 100 / cap) (100 for a 0 cap).
   */
  private margin(data: any, values: Settings) {
    const entitlement = this.active(data);
    if (!entitlement) return null;
    const plan: Plan = values.plans.find((p) => p.id === entitlement.plan.id) ?? entitlement.plan;
    const cap = plan.maxProviderCostMinor;
    if (cap === undefined) return null;
    const cost = this.periodCost(data);
    const percent = cap > 0 ? Math.floor((cost * 100) / cap) : 100;
    return {
      currency: values.credits.pack.currency,
      costMinor: cost,
      capMinor: cap,
      remainingMinor: round4(Math.max(0, cap - cost)),
      percent,
      threshold: thresholdOf(percent),
      resetAt: entitlement.periodEnd,
    };
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
  private settleWindows(userId: string, raw: any, data: any): Write[] {
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
          ...(p.shortSeconds !== undefined ? { shortUsed: c.short, shortResetAt: c.shortStart + p.shortSeconds * 1000 } : {}),
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
      const settled = this.settleWindows(user.id, previous, data);
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
    const writes: Write[] = [...this.settleWindows(userId, old.data, data)];
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
    meta: {
      reason?: string;
      kind?: LedgerKind;
      source?: LedgerSource;
      actorId?: string;
      details?: LedgerEntry["details"];
      /** Model usage (consumeUsage): checked against the model caps and counted; its provider cost. */
      rateId?: string;
      rateName?: string;
      costMinor?: number | null;
    } = {},
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
      const { entitlement, product } = await this.chargeable(data, productId);
      const settled = this.settleWindows(userId, old?.data, data);
      const counter = entitlement.counters[productId];
      const balance = data.creditBalance?.[productId] ?? 0;
      // Active reservations hold part of the allowance and balance: never spend them here.
      const free = this.free(data, productId);
      const fromAllowance = Math.min(credits, free.allowance);
      const fromBalance = credits - fromAllowance;
      if (fromBalance > free.balance) {
        const window =
          product.shortSeconds !== undefined && counter.short >= product.shortLimit!
            ? "short"
            : counter.day >= product.dailyLimit ? "day" : counter.week >= product.weeklyLimit ? "week" : "period";
        throw new HttpError(
          429,
          `Subscription ${window} limit reached. Add credits or wait for the reset.`,
        );
      }
      const values = (await this.settings()).values;
      const cap = this.rateCap(data, values, productId, meta.rateId);
      const capped = cap && exceededWindow(this.rateWindows(data, productId, cap), credits);
      if (capped) throw modelLimit(meta.rateName ?? meta.rateId!, capped);
      data.creditBalance ??= {};
      data.creditBalance[productId] = balance - fromBalance;
      // Window counters track the plan allowance only; additional credits live in creditBalance.
      counter.period += fromAllowance;
      counter.day += fromAllowance;
      counter.week += fromAllowance;
      if (product.shortSeconds !== undefined) counter.short += fromAllowance;
      this.countRate(data, productId, cap, credits);
      this.addCost(data, meta.costMinor, values.credits.pack.currency);
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
      const settled = this.settleWindows(userId, old?.data, data);
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
    // Round up to whole credits (tolerating float noise) and apply the per-request minimum.
    const { exact, credits } = rateCredits(selected, inputTokens, outputTokens);
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
      // Raw allowance and balance; the split and `available` are net of active reservations.
      const free = this.free(data, productId);
      const fromAllowance = Math.min(credits, free.allowance);
      const fromBalance = credits - fromAllowance;
      result.account = {
        userId: input.userId,
        productId,
        allowanceLeft: free.rawAllowance,
        additionalCredits: free.rawBalance,
        available: free.allowance + free.balance,
        fromAllowance,
        fromBalance,
        allowed: fromBalance <= free.balance && credits > 0,
        availableAfter: Math.max(0, free.allowance + free.balance - credits),
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
    const cost = providerCost(estimate.rate, estimate.inputTokens, estimate.outputTokens);
    const receipt = await this.consume(userId, productId, estimate.credits, requestId, {
      reason: estimate.rate.name + " request",
      details: {
        rateId: estimate.rate.id,
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
        ...(cost !== null ? { costMinor: cost } : {}),
      },
      rateId: estimate.rate.id,
      rateName: estimate.rate.name,
      costMinor: cost,
    });
    return { ...receipt, valueMinor: estimate.valueMinor, currency: estimate.currency, ...(cost !== null ? { costMinor: cost } : {}) };
  }

  // -------------------------------------------------------------------------
  // Credit reservations: reserve before a call, settle the real usage after it. Holds live on
  // the account row (`reservations`) and in SUB_RESERVATION#<userId>/<key> receipts, and every
  // change is a ledger entry in the same transaction. See reservations.ts and
  // docs/polyglot/subscriptions-reservations.md.
  // -------------------------------------------------------------------------

  /** Credits of `{credits}` or `{estimate}` (priced at its maximum); 400 with both or neither. */
  private async reservationAmount(input: any) {
    const credits = input?.credits,
      estimate = input?.estimate;
    const hasCredits = credits !== undefined && credits !== null;
    const hasEstimate = estimate !== undefined && estimate !== null;
    if (hasCredits === hasEstimate || (hasEstimate && (typeof estimate !== "object" || Array.isArray(estimate))))
      throw new HttpError(400, "Give credits or an estimate");
    if (hasCredits) return { credits: integer(credits, 1), estimate: undefined, rateName: undefined };
    const priced = await this.estimate({
      rateId: estimate.rateId,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.maxOutputTokens ?? 0,
    });
    return {
      credits: priced.credits as number,
      estimate: { rateId: priced.rate.id, inputTokens: priced.inputTokens, maxOutputTokens: priced.outputTokens },
      rateName: priced.rate.name as string,
    };
  }

  /**
   * Record the release of expired holds: a "release" entry at `expiresAt` (source system) and
   * the receipt marked "expired". Mutates `data` and returns writes for the caller's
   * transaction; the receipt of `skip` is left to the caller, which writes that row itself.
   */
  private async sweepHolds(userId: string, data: any, skip?: string): Promise<Write[]> {
    const now = this.now();
    const holds: Hold[] = data.reservations ?? [];
    const expired = holds.filter((h) => now >= h.expiresAt);
    if (!expired.length) return [];
    data.reservations = holds.filter((h) => now < h.expiresAt);
    const writes: Write[] = [];
    for (const hold of expired) {
      const row = await this.store.get(RESERVATIONS(userId), hold.key);
      if (row && hold.key !== skip && row.data.status === "active")
        writes.push(write(row, row.pk, row.sk, { ...row.data, status: "expired", releasedAt: hold.expiresAt }));
      writes.push(
        this.ledgerEntry(
          userId,
          data,
          {
            at: hold.expiresAt,
            kind: "release",
            source: "system",
            credits: 0,
            productId: hold.productId,
            reason: "Reservation expired · " + (row?.data.reason ?? hold.key),
            requestId: hold.key,
            held: -hold.credits,
          },
          "expire:" + hold.key,
        ),
      );
    }
    return writes;
  }

  /** What `reserve` returns; an active receipt past its TTL reads as "expired". */
  private reservationView(record: any, replayed: boolean) {
    const status = record.status === "active" && this.now() >= record.expiresAt ? "expired" : record.status;
    return {
      key: record.key,
      productId: record.productId,
      credits: record.credits,
      status,
      at: record.at,
      expiresAt: record.expiresAt,
      available: record.available,
      replayed,
    };
  }

  /**
   * Hold credits for a call before running it: `{credits}` or `{estimate: {rateId,
   * inputTokens, maxOutputTokens}}` priced at its maximum. Nothing is charged: the hold only
   * lowers what other calls can spend until `settle`, `release` or `expiresAt` (`ttlMs`,
   * default 15 minutes). Idempotent per key: the same key and amount return the stored
   * reservation with `replayed: true`; another product or amount fails with 409. Fails like
   * `consume` (402, 403) and with 429 when the credits do not fit (the message says how many
   * are missing) or 25 reservations are active. Writes the account, the receipt and a
   * "reservation" entry (0 credits, `held` +credits) in one transaction.
   * @example reserve("u1", "api", {key: "turn-7:0", estimate: {rateId: "standard", inputTokens: 1200, maxOutputTokens: 800}})
   *   → {key: "turn-7:0", productId: "api", credits: 4, status: "active", at, expiresAt: at + 900000, available, replayed: false}
   */
  async reserve(userId: string, productId: string, input: ReserveInput, meta: ReservationMeta = {}) {
    const key = reservationKey(input?.key);
    id(productId);
    const amount = await this.reservationAmount(input);
    const ttlMs = reservationTtl(input.ttlMs);
    const reason = reservationReason(input.reason);
    const source = meta.source ?? "api";
    return this.retry(async () => {
      const prior = await this.store.get(RESERVATIONS(userId), key);
      if (prior) {
        if (prior.data.productId !== productId || prior.data.credits !== amount.credits)
          throw new HttpError(409, "Reservation key already used with different amounts");
        return this.reservationView(prior.data, true);
      }
      const old = await this.account(userId),
        data = this.normalized(old?.data ?? {});
      const { product } = await this.chargeable(data, productId);
      const settled = this.settleWindows(userId, old?.data, data);
      const swept = await this.sweepHolds(userId, data);
      const holds: Hold[] = data.reservations ?? [];
      if (holds.length >= MAX_ACTIVE_RESERVATIONS) throw new HttpError(429, "Too many active reservations");
      const available = this.available(data, productId);
      if (amount.credits > available)
        throw new HttpError(429, `Not enough credits: ${amount.credits - available} missing. Add credits or wait for the reset.`);
      const cap = this.rateCap(data, (await this.settings()).values, productId, amount.estimate?.rateId);
      const capped = cap && exceededWindow(this.rateWindows(data, productId, cap), amount.credits);
      if (capped) throw modelLimit(amount.rateName!, capped);
      const at = this.now();
      const hold: Hold = { key, productId, credits: amount.credits, at, expiresAt: at + ttlMs, ...(cap ? { rateId: cap.rateId } : {}) };
      data.reservations = [...holds, hold];
      const text = reason ?? (amount.rateName ? amount.rateName + " request" : product.name + " usage");
      const entry = this.ledgerEntry(
        userId,
        data,
        {
          at,
          kind: "reservation",
          source,
          credits: 0,
          productId,
          reason: "Reserved · " + text,
          requestId: key,
          held: amount.credits,
          expiresAt: hold.expiresAt,
          ...(meta.actorId ? { actorId: meta.actorId } : {}),
        },
        "reserve:" + key,
      );
      const record = {
        ...hold,
        status: "active",
        available: this.available(data, productId),
        reason: text,
        source,
        ...(meta.actorId ? { actorId: meta.actorId } : {}),
        ...(amount.estimate ? { estimate: amount.estimate } : {}),
      };
      await this.store.transact([
        write(old, "SUB_ACCOUNTS", userId, data),
        write(undefined, RESERVATIONS(userId), key, record),
        ...settled,
        ...swept,
        entry,
      ]);
      return this.reservationView(record, false);
    });
  }

  /**
   * Charge the real usage of a reservation and remove its hold; the rest of the reserved
   * amount is never charged. Usage is `{credits}` or `{inputTokens, outputTokens}` priced with
   * the reserved rate. An expired reservation (a crash resumed after the TTL) is settled too:
   * the usage is charged from what is available then. Usage the account cannot cover is not
   * charged and is returned as `uncovered`, so balances never go negative. Idempotent per key:
   * the same usage returns the stored settlement with `replayed: true`; other usage fails with
   * 409. 404 for an unknown key (or, for source "user", a reservation the user did not make),
   * 409 once released. Writes a "settlement" entry (− charged, `held` − reserved).
   * @example settle("u1", "turn-7:0", {inputTokens: 1200, outputTokens: 150})
   *   → {key: "turn-7:0", reserved: 4, used: 2, credits: 2, uncovered: 0, status: "settled", ..., replayed: false}
   */
  async settle(userId: string, key: string, usage: SettleUsage, meta: ReservationMeta = {}) {
    const k = reservationKey(key);
    const reported = settleUsage(usage);
    return this.retry(async () => {
      const row = await this.store.get(RESERVATIONS(userId), k);
      if (!row || (meta.source === "user" && row.data.source !== "user")) throw new HttpError(404, "Reservation not found");
      const record = row.data;
      if (record.status === "settled") {
        if (!sameUsage(record.settlement.usage, reported))
          throw new HttpError(409, "Reservation already settled with different usage");
        return { ...record.settlement, replayed: true };
      }
      if (record.status === "released") throw new HttpError(409, "Reservation was released");
      if (!("credits" in reported) && !record.estimate) throw new HttpError(400, "Settle this reservation with credits");
      const settings = await this.settings();
      const priced =
        "credits" in reported
          ? undefined
          : await this.estimate({ rateId: record.estimate.rateId, inputTokens: reported.inputTokens, outputTokens: reported.outputTokens });
      const used: number = priced ? priced.credits : (reported as { credits: number }).credits;
      const old = await this.account(userId),
        data = this.normalized(old?.data ?? {});
      const settled = this.settleWindows(userId, old?.data, data);
      const swept = await this.sweepHolds(userId, data, k);
      const holds: Hold[] = data.reservations ?? [];
      const hold = holds.find((h) => h.key === k);
      if (hold) data.reservations = holds.filter((h) => h !== hold);
      // Charge like consume (allowance first) from what the other holds leave free.
      const productId: string = record.productId;
      const free = this.free(data, productId);
      const fromAllowance = Math.min(used, free.allowance);
      const fromBalance = Math.min(used - fromAllowance, free.balance);
      const charged = fromAllowance + fromBalance;
      const uncovered = used - charged;
      if (fromAllowance > 0) {
        const entitlement = this.effective(data);
        const counter = entitlement.counters[productId];
        counter.period += fromAllowance;
        counter.day += fromAllowance;
        counter.week += fromAllowance;
        if (entitlement.plan.products.find((p: Product) => p.id === productId)?.shortSeconds !== undefined) counter.short += fromAllowance;
      }
      // Model caps count what was used (uncovered included); provider cost is the full usage.
      this.countRate(data, productId, this.rateCap(data, settings.values, productId, record.estimate?.rateId), used);
      const cost = priced ? providerCost(priced.rate, priced.inputTokens, priced.outputTokens) : null;
      this.addCost(data, cost, settings.values.credits.pack.currency);
      data.creditBalance ??= {};
      data.creditBalance[productId] = free.rawBalance - fromBalance;
      data.totalConsumed = (data.totalConsumed ?? 0) + charged;
      const at = this.now();
      const pack = settings.values.credits.pack;
      const entry = this.ledgerEntry(
        userId,
        data,
        {
          at,
          kind: "settlement",
          source: meta.source ?? "api",
          credits: charged ? -charged : 0,
          productId,
          reason: record.reason,
          requestId: k,
          fromAllowance,
          fromBalance,
          held: hold ? -hold.credits : 0,
          details: {
            ...(priced ? { rateId: priced.rate.id, inputTokens: priced.inputTokens, outputTokens: priced.outputTokens } : {}),
            reserved: record.credits,
            used,
            uncovered,
            ...(cost !== null ? { costMinor: cost } : {}),
          },
          ...(meta.actorId ? { actorId: meta.actorId } : {}),
        },
        "settle:" + k,
      );
      const settlement = {
        key: k,
        productId,
        reserved: record.credits,
        used,
        credits: charged,
        fromAllowance,
        fromBalance,
        uncovered,
        expired: !hold,
        status: "settled",
        at,
        available: this.available(data, productId),
        valueMinor: Math.round((charged * pack.amountMinor) / pack.credits),
        currency: pack.currency,
        usage: reported,
        ...(cost !== null ? { costMinor: cost } : {}),
      };
      await this.store.transact([
        write(old, "SUB_ACCOUNTS", userId, data),
        write(row, row.pk, row.sk, { ...record, status: "settled", settlement }),
        ...settled,
        ...swept,
        entry,
      ]);
      return { ...settlement, replayed: false };
    });
  }

  /** What `release` returns. */
  private releaseView(record: any, replayed: boolean) {
    return {
      key: record.key,
      productId: record.productId,
      credits: record.credits,
      status: record.status,
      releasedAt: record.releasedAt,
      replayed,
    };
  }

  /**
   * Remove a reservation's hold without charging it (the call did not run). Idempotent: a
   * released or expired reservation returns its state with `replayed: true`. 409 once
   * settled; 404 for an unknown key (or, for source "user", a reservation the user did not
   * make). An active receipt past its TTL is recorded as "expired". Writes a "release" entry.
   */
  async release(userId: string, key: string, meta: ReservationMeta = {}) {
    const k = reservationKey(key);
    return this.retry(async () => {
      const row = await this.store.get(RESERVATIONS(userId), k);
      if (!row || (meta.source === "user" && row.data.source !== "user")) throw new HttpError(404, "Reservation not found");
      const record = row.data;
      if (record.status === "settled") throw new HttpError(409, "Reservation already settled");
      if (record.status !== "active") return this.releaseView(record, true);
      const old = await this.account(userId),
        data = this.normalized(old?.data ?? {});
      const writes = [...this.settleWindows(userId, old?.data, data), ...(await this.sweepHolds(userId, data, k))];
      const holds: Hold[] = data.reservations ?? [];
      const hold = holds.find((h) => h.key === k);
      let next;
      if (hold) {
        data.reservations = holds.filter((h) => h !== hold);
        const at = this.now();
        writes.push(
          this.ledgerEntry(
            userId,
            data,
            {
              at,
              kind: "release",
              source: meta.source ?? "api",
              credits: 0,
              productId: record.productId,
              reason: "Released · " + record.reason,
              requestId: k,
              held: -hold.credits,
              ...(meta.actorId ? { actorId: meta.actorId } : {}),
            },
            "release:" + k,
          ),
        );
        next = { ...record, status: "released", releasedAt: at };
      } else next = { ...record, status: "expired", releasedAt: record.expiresAt };
      await this.store.transact([write(old, "SUB_ACCOUNTS", userId, data), write(row, row.pk, row.sk, next), ...writes]);
      return this.releaseView(next, false);
    });
  }

  /** Day, week and period usage of a product, holds included (see `windowUsage`); [] without one. */
  private usageWindows(data: any, productId: string) {
    const entitlement = this.effective(data);
    if (!entitlement?.plan || entitlement.status !== "active" || this.now() >= entitlement.periodEnd) return [];
    const product: Product | undefined = entitlement.plan.products.find((p: Product) => p.id === productId);
    const c = entitlement.counters?.[productId];
    if (!product || !c) return [];
    // Holds sit on the allowance first: that part counts on every window once settled.
    const reserved = Math.min(this.held(data, productId), this.allowanceLeft(data, productId));
    return [
      ...(product.shortSeconds !== undefined
        ? [windowUsage("short", c.short, reserved, product.shortLimit!, c.shortStart + product.shortSeconds * 1000)]
        : []),
      windowUsage("day", c.day, reserved, product.dailyLimit, c.dayStart + product.daySeconds * 1000),
      windowUsage("week", c.week, reserved, product.weeklyLimit, c.weekStart + product.weekSeconds * 1000),
      windowUsage("period", c.period, reserved, product.credits, entitlement.periodEnd),
    ];
  }

  /**
   * Pre-flight check of a batch before running it: does `{credits}` or `{estimate}` fit in what
   * the user can spend now (plan allowance, the tightest window, plus additional credits,
   * minus active reservations)? Returns `fits`, `reason` (null, "inactive", "payment",
   * "product" or "credits"), `available` (0 when blocked), `missing`, the window usage with the
   * threshold reached and, when credits are missing, a `topUp` offer priced with the credit
   * pack. Never writes.
   * @example preflight("u1", "api", {credits: 150}) with 100 available
   *   → {fits: false, reason: "credits", available: 100, missing: 50, topUp: {credits: 50, packs: 1, amountMinor: 1000, valueMinor: 50, currency: "usd"}, ...}
   */
  async preflight(userId: string, productId: string, input: { credits?: number; estimate?: ReserveInput["estimate"] }) {
    id(productId);
    const amount = await this.reservationAmount(input);
    const settings = await this.settings();
    const row = await this.account(userId);
    const data = this.normalized(row?.data ?? {});
    const blocked = this.blocked(data, productId, settings.values.paymentRequired);
    const free = this.free(data, productId);
    const available = blocked ? 0 : free.allowance + free.balance;
    const missing = Math.max(0, amount.credits - available);
    const cap = blocked ? undefined : this.rateCap(data, settings.values, productId, amount.estimate?.rateId);
    const models = this.rateWindows(data, productId, cap);
    const capped = cap ? exceededWindow(models, amount.credits) : null;
    const fits = !blocked && missing === 0 && !capped;
    const pack = settings.values.credits.pack;
    const packs = Math.ceil(missing / pack.credits);
    const rate = amount.estimate && settings.values.credits.rates.find((r) => r.id === amount.estimate!.rateId);
    const cost = rate ? providerCost(rate, amount.estimate!.inputTokens, amount.estimate!.maxOutputTokens) : null;
    const margin = blocked ? null : this.margin(data, settings.values);
    const exceeded = !!margin && round4(margin.costMinor + (cost ?? 0)) > margin.capMinor;
    return {
      productId,
      credits: amount.credits,
      fits,
      reason: fits ? null : (blocked ?? (missing > 0 ? "credits" : "model")),
      available,
      missing,
      allowanceLeft: free.rawAllowance,
      additionalCredits: free.rawBalance,
      reserved: free.held,
      windows: this.usageWindows(data, productId),
      topUp:
        !blocked && missing > 0
          ? {
              credits: missing,
              packs,
              amountMinor: packs * pack.amountMinor,
              valueMinor: Math.round((missing * pack.amountMinor) / pack.credits),
              currency: pack.currency,
            }
          : null,
      costMinor: cost,
      model: cap ? { rateId: cap.rateId, windows: models, exceeded: capped } : null,
      margin: margin ? { ...margin, stepMinor: cost ?? 0, exceeded } : null,
      degrade:
        rate && !blocked && (missing > 0 || capped || exceeded)
          ? this.degrade(data, settings.values, productId, rate, amount.estimate!, available, margin)
          : null,
    };
  }

  /**
   * A cheaper rate for the same step when it does not fit (credits, a model cap or the margin
   * rule): among the other rates (settings order), those strictly cheaper than `current` by
   * (provider cost, credits) that fit the available credits, their own caps and the margin
   * left, the least degradation wins: the highest (cost, credits), first on ties. Rates
   * without costs cost 0. Null when none fits.
   */
  private degrade(
    data: any,
    values: Settings,
    productId: string,
    current: CreditRate,
    estimate: { inputTokens: number; maxOutputTokens?: number },
    available: number,
    margin: { costMinor: number; capMinor: number } | null,
  ) {
    const tokensIn = estimate.inputTokens,
      tokensOut = estimate.maxOutputTokens ?? 0;
    const price = (r: CreditRate) => ({ rate: r, credits: rateCredits(r, tokensIn, tokensOut).credits, cost: providerCost(r, tokensIn, tokensOut) });
    const base = price(current);
    const cheaper = (a: ReturnType<typeof price>, b: ReturnType<typeof price>) =>
      (a.cost ?? 0) < (b.cost ?? 0) || ((a.cost ?? 0) === (b.cost ?? 0) && a.credits < b.credits);
    let best: ReturnType<typeof price> | undefined;
    for (const r of values.credits.rates) {
      if (r.id === current.id) continue;
      const option = price(r);
      if (!cheaper(option, base) || option.credits > available) continue;
      const cap = this.rateCap(data, values, productId, r.id);
      if (cap && exceededWindow(this.rateWindows(data, productId, cap), option.credits)) continue;
      if (margin && round4(margin.costMinor + (option.cost ?? 0)) > margin.capMinor) continue;
      if (!best || cheaper(best, option)) best = option;
    }
    return best ? { rateId: best.rate.id, name: best.rate.name, credits: best.credits, costMinor: best.cost } : null;
  }

  /**
   * Usage against limits for each product of the user (the effective plan's, then other
   * additional-credit balances): raw allowance and balance, `reserved`, net `available`, the
   * day/week/period windows with their threshold (0, 80, 95 or 100), active reservations,
   * `alerts` for every window at 80 % or more, and the credit pack for a top-up offer.
   * Never writes.
   */
  async usageSummary(userId: string) {
    const settings = await this.settings();
    const row = await this.account(userId);
    const data = this.normalized(row?.data ?? {});
    const plan: Product[] = this.effective(data).plan?.products ?? [];
    const products = plan.map((p) => p.id);
    for (const productId of Object.keys(data.creditBalance ?? {})) if (!products.includes(productId)) products.push(productId);
    const items = products.map((productId) => {
      const free = this.free(data, productId);
      const windows = this.usageWindows(data, productId);
      const models = this.rateCaps(data, settings.values, productId).map((cap) => ({
        rateId: cap.rateId,
        name: settings.values.credits.rates.find((r) => r.id === cap.rateId)?.name ?? null,
        windows: this.rateWindows(data, productId, cap),
      }));
      return {
        productId,
        name: plan.find((p) => p.id === productId)?.name ?? null,
        allowanceLeft: free.rawAllowance,
        additionalCredits: free.rawBalance,
        reserved: free.held,
        available: free.allowance + free.balance,
        threshold: Math.max(0, ...windows.map((w) => w.threshold)),
        windows,
        ...(models.length ? { models } : {}),
      };
    });
    return {
      userId,
      active: this.blocked(data, undefined, settings.values.paymentRequired) === null,
      products: items,
      reservations: activeHolds(data.reservations, this.now()).map((h) => ({
        key: h.key,
        productId: h.productId,
        credits: h.credits,
        at: h.at,
        expiresAt: h.expiresAt,
      })),
      alerts: items.flatMap((p) => [
        ...p.windows
          .filter((w) => w.threshold >= 80)
          .map((w) => ({ productId: p.productId, window: w.kind, percent: w.percent, threshold: w.threshold })),
        ...(p.models ?? []).flatMap((m) =>
          m.windows
            .filter((w) => w.threshold >= 80)
            .map((w) => ({ productId: p.productId, window: w.kind, percent: w.percent, threshold: w.threshold, rateId: m.rateId })),
        ),
      ]),
      pack: settings.values.credits.pack,
      margin: this.margin(data, settings.values),
    };
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

  /**
   * Unit economics: per user and per plan, provider cost (all time: settlements and model usage
   * priced with the rates' costs), revenue (money paid: purchases and paid plans, from the
   * ledger totals) and margin (revenue − cost), per currency with 4 decimals. Accounts with no
   * active plan, cost or revenue are skipped; users are grouped by their current plan ("none"
   * without one). Returns the `limit` (1..200, default 50) users with the highest cost in the
   * pack currency (then by id), every plan (by id) and the totals. Never writes.
   */
  async economics(limit = 50) {
    integer(limit, 1, 200);
    const values = (await this.settings()).values;
    const currency = values.credits.pack.currency;
    type Money = Record<string, number>;
    const add = (target: Money, source: Money, sign = 1) => {
      for (const [code, value] of Object.entries(source)) target[code] = round4((target[code] ?? 0) + sign * value);
    };
    const totals = { users: 0, costMinor: {} as Money, revenueMinor: {} as Money, marginMinor: {} as Money };
    const plans: Record<string, { planId: string; name: string | null; users: number; costMinor: Money; revenueMinor: Money; marginMinor: Money }> = {};
    const users: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list("SUB_ACCOUNTS", cursor);
      for (const row of page.items) {
        const data = this.normalized(row.data);
        const entitlement = this.active(data);
        const cost: Money = data.providerCost?.totalMinor ?? {};
        const revenue: Money = data.ledgerTotals?.paidMinor ?? {};
        if (!entitlement && !Object.keys(cost).length && !Object.keys(revenue).length) continue;
        const margin: Money = {};
        add(margin, revenue);
        add(margin, cost, -1);
        const live: Plan | undefined = entitlement && (values.plans.find((p) => p.id === entitlement.plan.id) ?? entitlement.plan);
        users.push({
          userId: row.sk,
          planId: live?.id ?? null,
          costMinor: cost,
          revenueMinor: revenue,
          marginMinor: margin,
          periodCostMinor: this.periodCost(data),
          capMinor: live?.maxProviderCostMinor ?? null,
        });
        const key = live?.id ?? "none";
        const group = (plans[key] ??= { planId: key, name: live?.name ?? null, users: 0, costMinor: {}, revenueMinor: {}, marginMinor: {} });
        group.users++;
        add(group.costMinor, cost);
        add(group.revenueMinor, revenue);
        add(group.marginMinor, margin);
        totals.users++;
        add(totals.costMinor, cost);
        add(totals.revenueMinor, revenue);
        add(totals.marginMinor, margin);
      }
      cursor = page.cursor;
    } while (cursor);
    const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    users.sort((a, b) => (b.costMinor[currency] ?? 0) - (a.costMinor[currency] ?? 0) || order(a.userId, b.userId));
    return {
      asOf: this.now(),
      currency,
      totals,
      plans: Object.values(plans).sort((a, b) => order(a.planId, b.planId)),
      users: users.slice(0, limit),
    };
  }

  async reset(userId: string, input: any, actorId: string) {
    const key = id(input.requestId),
      scope = input.scope;
    if (!["short", "day", "week", "period", "all"].includes(scope))
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
      const settled = this.settleWindows(userId, row.data, data);
      const entries: Write[] = [];
      for (const [productId, c] of Object.entries(this.effective(data).counters) as [string, any][]) {
        const before = this.allowanceLeft(data, productId);
        for (const field of ["short", "day", "week", "period"])
          if ((scope === "all" || scope === field) && (field !== "short" || c.short !== undefined)) {
            c[field] = 0;
            resetRateWindow(c, field);
          }
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
      const settled = this.settleWindows(userId, row?.data, data);
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
        // Accounts without an own plan are skipped unless expired holds need releasing
        // (reservations made on an administrator-assigned plan).
        const expiredHolds = (d.reservations ?? []).some((h: Hold) => this.now() >= h.expiresAt);
        if (!d.plan && !expiredHolds) continue;
        const renew = !!d.plan && d.mode === "none" && !d.cancelAtPeriodEnd && this.now() >= d.periodEnd;
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
        const settled = this.settleWindows(row.sk, d, next);
        // Release expired reservations after the window rollover, in the same transaction.
        const swept = await this.sweepHolds(row.sk, next);
        if (renew || settled.length || swept.length)
          await this.store
            .transact([write(row, row.pk, row.sk, next), ...settled, ...swept])
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
          maxBodyBytes: 262_144,
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
          path: "/subscriptions/admin/economics",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_economics",
            description:
              "Unit economics: provider cost (settlements priced with the rates' costs), revenue (money paid) and margin per currency, per plan and for the users with the highest cost. query.limit (1-200, default 50). Never writes.",
            example: { query: { limit: "50" } },
          },
          handle: (c) => this.economics(c.request.query.limit ? Number(c.request.query.limit) : 50),
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
              details: ledgerDetails(body.details),
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
        // Credit reservations. Personal endpoints act on the signed-in user's own reservations
        // (source "user"); a backend that meters model calls uses the owner endpoints below
        // (admin token), whose reservations the user cannot settle or release.
        {
          method: "GET",
          path: "/subscriptions/credits/usage",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.usageSummary(c.actor!.id),
        },
        {
          method: "POST",
          path: "/subscriptions/credits/preflight",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.preflight(c.actor!.id, c.request.body.productId, amountBody(c.request.body)),
        },
        {
          method: "POST",
          path: "/subscriptions/credits/reservations",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) =>
            this.reserve(c.actor!.id, c.request.body.productId, reserveBody(c.request.body), { source: "user", actorId: c.actor!.id }),
        },
        {
          method: "POST",
          path: "/subscriptions/credits/reservations/:key/settle",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.settle(c.actor!.id, c.params.key, usageBody(c.request.body), { source: "user", actorId: c.actor!.id }),
        },
        {
          method: "POST",
          path: "/subscriptions/credits/reservations/:key/release",
          resource: "subscriptions.me",
          access: "authenticated",
          handle: (c) => this.release(c.actor!.id, c.params.key, { source: "user", actorId: c.actor!.id }),
        },
        {
          method: "GET",
          path: "/subscriptions/admin/accounts/:id/usage",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_usage",
            description:
              "Usage against limits for a user: per product the day/week/period windows (used, reserved, limit, percent, threshold 0|80|95|100), active reservations, alerts at 80% or more and the credit pack for a top-up. params.id user. Never writes.",
            example: { params: { id: "USER_ID" } },
          },
          handle: (c) => this.usageSummary(c.params.id),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/preflight",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_preflight",
            description:
              "Check whether a batch fits before running it. Body: productId and credits, or estimate {rateId, inputTokens, maxOutputTokens}. Returns fits, reason (inactive|payment|product|credits), available, missing, windows and a topUp offer. Never writes.",
            example: { params: { id: "USER_ID" }, body: { productId: "api", estimate: { rateId: "standard", inputTokens: 1200, maxOutputTokens: 800 } } },
          },
          handle: (c) => this.preflight(c.params.id, c.request.body.productId, amountBody(c.request.body)),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/reservations",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_reserve",
            description:
              "Hold credits before a model call. Body: key (stable, e.g. turnId:step), productId, credits or estimate {rateId, inputTokens, maxOutputTokens}, optional ttlMs (default 900000) and reason. Reuse the key for retries; the same key with another amount fails with 409.",
            example: { params: { id: "USER_ID" }, body: { key: "turn-1:0", productId: "api", estimate: { rateId: "standard", inputTokens: 1200, maxOutputTokens: 800 } } },
          },
          handle: (c) =>
            this.reserve(c.params.id, c.request.body.productId, reserveBody(c.request.body), { source: "api", actorId: c.actor!.id }),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/reservations/:key/settle",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_settle",
            description:
              "Charge the real usage of a reservation and release the rest. Body: inputTokens and outputTokens (priced with the reserved rate) or credits. Works after the reservation expired; returns uncovered credits it could not charge. Idempotent per key.",
            example: { params: { id: "USER_ID", key: "turn-1:0" }, body: { inputTokens: 1200, outputTokens: 150 } },
          },
          handle: (c) => this.settle(c.params.id, c.params.key, usageBody(c.request.body), { source: "api", actorId: c.actor!.id }),
        },
        {
          method: "POST",
          path: "/subscriptions/admin/accounts/:id/reservations/:key/release",
          resource: "subscriptions.manage",
          access: "owner",
          tool: {
            name: "subscriptions_credits_release",
            description: "Release a reservation without charging it (the call did not run). Idempotent per key.",
            example: { params: { id: "USER_ID", key: "turn-1:0" } },
          },
          handle: (c) => this.release(c.params.id, c.params.key, { source: "api", actorId: c.actor!.id }),
        },
        // Metering for backends with a scoped service key (resource "subscriptions.meter"): the
        // same calls as the owner endpoints above, on the account in the path, source "api" and
        // actorId "service:<key id>". No user, settings or plan endpoint is reachable this way.
        ...this.meterEndpoints(),
      ],
    };
  }

  /** `access: "service"` endpoints of the `subscriptions.meter` scope. */
  private meterEndpoints(): Endpoint[] {
    const account = (c: Context) => id(c.params.id);
    const meta = (c: Context) => ({ source: "api" as const, actorId: c.actor!.id });
    const base = "/service/subscriptions/accounts/:id";
    return [
      { method: "GET", path: base + "/usage", resource: METER, access: "service", handle: async (c) => this.usageSummary(account(c)) },
      {
        method: "POST",
        path: base + "/preflight",
        resource: METER,
        access: "service",
        handle: async (c) => this.preflight(account(c), c.request.body.productId, amountBody(c.request.body)),
      },
      {
        method: "POST",
        path: base + "/reservations",
        resource: METER,
        access: "service",
        handle: async (c) => this.reserve(account(c), c.request.body.productId, reserveBody(c.request.body), meta(c)),
      },
      {
        method: "POST",
        path: base + "/reservations/:key/settle",
        resource: METER,
        access: "service",
        handle: async (c) => this.settle(account(c), c.params.key, usageBody(c.request.body), meta(c)),
      },
      {
        method: "POST",
        path: base + "/reservations/:key/release",
        resource: METER,
        access: "service",
        handle: async (c) => this.release(account(c), c.params.key, meta(c)),
      },
      {
        method: "POST",
        path: base + "/ledger",
        resource: METER,
        access: "service",
        // Debits only: a metering key charges usage; adding credits stays with the owner.
        handle: async (c) => {
          const body = c.request.body;
          const userId = account(c);
          if (typeof body.credits === "number" && body.credits > 0) throw new HttpError(403, "Service keys can only record debits");
          return this.recordCredits(userId, {
            requestId: body.requestId,
            productId: body.productId,
            credits: body.credits,
            kind: body.kind,
            reason: body.reason,
            details: ledgerDetails(body.details),
            source: "api",
            actorId: c.actor!.id,
          });
        },
      },
    ];
  }
}

/** Scope of the metering endpoints a service key may call (see ServiceKeys in rt-app-auth). */
export const METER = "subscriptions.meter";

export { LocalBilling } from "./local.js";
