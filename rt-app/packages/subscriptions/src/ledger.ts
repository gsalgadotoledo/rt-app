import { createHash } from "node:crypto";
import type { Write } from "@gsalgadotoledo/rt-app-nosql";

/**
 * Credit ledger: an append-only, chronological statement per user (`SUB_LEDGER#<userId>`).
 * Every entry is written in the same transaction as the account change it describes, so the
 * statement and the balances can never disagree. Credits are signed: + credit, − debit.
 */
export type LedgerKind =
  | "allowance" // plan credits granted for a new window (weekly)
  | "expiry" // unused plan credits of a closed window
  | "usage" // consumption (plan allowance first, then additional credits)
  | "grant" // additional credits assigned by an administrator
  | "purchase" // additional credits bought (top-up)
  | "plan" // plan started, changed, renewed or assigned
  | "adjustment" // manual or programmatic correction
  | "reset"; // courtesy reset of usage windows

export type LedgerSource = "system" | "admin" | "billing" | "user" | "api";

export interface LedgerEntry {
  id: string;
  at: number;
  kind: LedgerKind;
  source: LedgerSource;
  credits: number;
  productId?: string;
  planId?: string;
  reason: string;
  actorId?: string;
  requestId?: string;
  /** Money paid (purchase, plan) or recorded value (admin grant), in minor units. */
  amountMinor?: number;
  currency?: string;
  /** Split of a usage debit between the plan allowance and additional credits. */
  fromAllowance?: number;
  fromBalance?: number;
  /** Credits available for the product right after this entry. */
  available?: number;
  details?: Record<string, string | number | boolean>;
}

export interface LedgerTotals {
  creditsIn: number;
  creditsOut: number;
  expired: number;
  /** Money actually paid, per currency (purchases and paid plans). */
  paidMinor: Record<string, number>;
  /** Value recorded for administrative assignments, per currency. Not a charge. */
  grantedValueMinor: Record<string, number>;
}

export const emptyTotals = (): LedgerTotals => ({
  creditsIn: 0,
  creditsOut: 0,
  expired: 0,
  paidMinor: {},
  grantedValueMinor: {},
});

export const LEDGER = (userId: string) => "SUB_LEDGER#" + userId;

/**
 * Sort key: zero-padded time, the account's write sequence (order within the same millisecond),
 * then a hash of the event, so `list` returns the statement in chronological order.
 */
export function ledgerKey(at: number, seed: string, sequence = 0) {
  return String(at).padStart(15, "0") + "-" + String(sequence).padStart(10, "0") + "-" + createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/** Build the entry write (conditional create: a replayed key never writes twice). */
export function ledgerWrite(userId: string, entry: Omit<LedgerEntry, "id">, seed: string, sequence = 0): { entry: LedgerEntry; write: Write } {
  const id = ledgerKey(entry.at, seed, sequence);
  const full = { ...entry, id };
  return { entry: full, write: { row: { pk: LEDGER(userId), sk: id, version: 1, data: full }, expected: null } };
}

/** Fold one entry into the account's running totals (stored on the account row). */
export function applyTotals(totals: LedgerTotals | undefined, entry: LedgerEntry): LedgerTotals {
  const next = structuredClone(totals ?? emptyTotals());
  if (entry.kind === "expiry") next.expired += -entry.credits;
  else if (entry.credits > 0) next.creditsIn += entry.credits;
  else next.creditsOut += -entry.credits;
  if (entry.amountMinor && entry.currency) {
    const bucket = entry.kind === "grant" || entry.source === "admin" ? next.grantedValueMinor : next.paidMinor;
    bucket[entry.currency] = (bucket[entry.currency] ?? 0) + entry.amountMinor;
  }
  return next;
}

/** Last settled allowance window per product, stored on the account (`ledgerWindows`). */
export interface WindowState {
  /** Entitlement identity: a different key (plan change, admin assignment) closes all windows. */
  key: string;
  products: Record<string, { start: number; allowance: number; name: string; weekSeconds: number }>;
}

export interface CurrentWindow {
  key: string;
  /** Current period; weekly windows restart at every period boundary (e.g. 30-day renewals). */
  periodStart: number;
  periodMs: number;
  products: Array<{ id: string; name: string; weeklyLimit: number; weekSeconds: number; start: number }>;
}

type PendingEntry = Omit<LedgerEntry, "id" | "source" | "available"> & { seed: string };

/**
 * Pure window accounting between the last settled state and the current usage windows.
 * Closed windows expire their unused plan allowance; each new window grants a fresh one.
 * `used(productId, start)` returns the allowance consumed in a settled window. Skipped windows
 * (inactivity) are folded into one expiry entry, so the statement stays bounded.
 * @example previous {api:{start:0,allowance:500}}, current start 604800000, used 120
 *   → expiry −380 at 604800000, allowance +500 at 604800000
 */
export function rollover(
  previous: WindowState | undefined,
  current: CurrentWindow | undefined,
  used: (productId: string, start: number) => number,
  now: number,
) {
  const entries: PendingEntry[] = [];
  const continuing = previous && current && previous.key === current.key;
  for (const [productId, window] of Object.entries(previous?.products ?? {})) {
    const step = window.weekSeconds * 1000;
    const next = continuing ? current!.products.find((p) => p.id === productId) : undefined;
    if (next && next.start === window.start) continue;
    // Same arithmetic as the usage counters: a window ends after `step` or at the period boundary.
    const following = (start: number) => {
      if (!current) return start + step;
      const periodEnd = current.periodStart + (Math.floor((start - current.periodStart) / current.periodMs) + 1) * current.periodMs;
      return Math.min(start + step, periodEnd);
    };
    // A window closes at its natural end, or now when the entitlement changed mid-window.
    const closedAt = next ? Math.min(following(window.start), next.start) : Math.min(window.start + step, now);
    let skipped = 0;
    // Bounded walk over idle windows (about ten years of weekly windows at most).
    for (let start = closedAt; next && start < next.start && skipped < 520; start = following(start)) skipped++;
    const unused = Math.max(0, window.allowance - used(productId, window.start));
    const expired = unused + skipped * window.allowance;
    if (expired > 0)
      entries.push({
        at: closedAt,
        kind: "expiry",
        credits: -expired,
        productId,
        reason: skipped > 0
          ? `${window.name}: unused allowance of ${skipped + 1} weeks expired`
          : next
            ? `${window.name}: unused weekly allowance expired`
            : `${window.name}: allowance ended with the plan`,
        details: { unused, skippedWeeks: skipped },
        // `now` distinguishes a window closed, reopened and closed again; the account version
        // (same transaction) already prevents concurrent duplicates.
        seed: `expiry:${previous!.key}:${productId}:${window.start}:${now}`,
      });
  }
  const state: WindowState | undefined = current && {
    key: current.key,
    products: Object.fromEntries(current.products.map((p) => [p.id, { start: p.start, allowance: p.weeklyLimit, name: p.name, weekSeconds: p.weekSeconds }])),
  };
  for (const product of current?.products ?? []) {
    const known = continuing ? previous!.products[product.id] : undefined;
    if (known && known.start === product.start) continue;
    entries.push({
      // A plan change mid-window opens the new allowance when it happens, after the old one closed.
      at: previous && !continuing ? Math.max(product.start, now) : product.start,
      kind: "allowance",
      credits: product.weeklyLimit,
      productId: product.id,
      reason: `${product.name}: weekly allowance`,
      seed: `allowance:${current!.key}:${product.id}:${product.start}:${now}`,
    });
  }
  entries.sort((a, b) => a.at - b.at || (a.kind === "expiry" ? -1 : 1));
  return { entries, state };
}
