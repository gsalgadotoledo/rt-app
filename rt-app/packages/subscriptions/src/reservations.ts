import { HttpError } from "@gsalgadotoledo/rt-app-contracts";

/**
 * Credit reservations (reserve and settle): pure helpers and types. The service methods live in
 * `Subscriptions` (index.ts): `reserve`, `settle`, `release`, `preflight` and `usageSummary`.
 *
 * A reservation is a hold on a product's credits, stored on the account row (`reservations`, an
 * array in creation order) and as a receipt row (`SUB_RESERVATION#<userId>/<key>`). Holds are
 * not debits: they only lower what other calls can spend until the reservation is settled
 * (the real usage is charged), released, or expires (`expiresAt`, a TTL). Expired holds stop
 * counting at once; the next reservation write or maintenance records their release.
 * See docs/polyglot/subscriptions-reservations.md.
 */

/** Row partition of reservation receipts. */
export const RESERVATIONS = (userId: string) => "SUB_RESERVATION#" + userId;

/** Default time a reservation holds credits: 15 minutes. */
export const RESERVATION_TTL_MS = 15 * 60_000;

/** Bounds of `ttlMs`: 1 second to 24 hours. */
export const MIN_RESERVATION_TTL_MS = 1_000;
export const MAX_RESERVATION_TTL_MS = 86_400_000;

/**
 * Active reservations per user. Bounds the account row and the transaction that releases
 * expired holds (DynamoDB accepts 100 items per transaction).
 */
export const MAX_ACTIVE_RESERVATIONS = 25;

/** Usage thresholds reported for each window: callers warn at 80 and 95 percent. */
export const THRESHOLDS = [80, 95, 100] as const;

export type ReservationStatus = "active" | "settled" | "released" | "expired";

/** A hold as stored on the account row. */
export interface Hold {
  key: string;
  productId: string;
  credits: number;
  at: number;
  expiresAt: number;
}

/** Input of `reserve`: a fixed amount of credits, or a model call priced at its maximum. */
export interface ReserveInput {
  /** Stable key, e.g. "<turnId>:<step>": letters, digits, `_ - . :`, 1 to 128 characters. */
  key: string;
  credits?: number;
  /** Known input tokens plus the output cap, priced with the credit rate `rateId`. */
  estimate?: { rateId: string; inputTokens: number; maxOutputTokens?: number };
  /** Hold time in milliseconds (default 15 minutes, 1 s to 24 h). */
  ttlMs?: number;
  /** Statement text (default "<rate name> request" or "<product name> usage"). */
  reason?: string;
}

/** Real usage reported to `settle`: credits, or token counts priced with the reserved rate. */
export type SettleUsage = { credits: number } | { inputTokens: number; outputTokens?: number };

/** Who acts: "user" (personal endpoints: only the user's own reservations), "api" by default. */
export interface ReservationMeta {
  source?: "system" | "admin" | "billing" | "user" | "api";
  actorId?: string;
}

/** Reservation keys allow ":" and "." so a "<turnId>:<step>" key needs no encoding. */
export function reservationKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new HttpError(400, "Invalid reservation key");
  return value;
}

/** `ttlMs ?? 15 min`, a safe integer between 1 s and 24 h. */
export function reservationTtl(value: unknown): number {
  if (value === undefined || value === null) return RESERVATION_TTL_MS;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_RESERVATION_TTL_MS || (value as number) > MAX_RESERVATION_TTL_MS)
    throw new HttpError(400, "Invalid reservation TTL");
  return value as number;
}

/** Optional statement text: trimmed, 1 to 300 characters when given. */
export function reservationReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const reason = String(value).trim();
  if (!reason || reason.length > 300) throw new HttpError(400, "A short reason is required");
  return reason;
}

/** Highest threshold reached by a usage percentage: 0, 80, 95 or 100. */
export function thresholdOf(percent: number): number {
  return percent >= 100 ? 100 : percent >= 95 ? 95 : percent >= 80 ? 80 : 0;
}

/**
 * One usage window with the part of the holds that sits on the plan allowance.
 * percent = floor((used + reserved) * 100 / limit), 100 when the limit is 0.
 * @example windowUsage("day", 60, 25, 100, 86400000) → {kind:"day", used:60, reserved:25, limit:100, remaining:15, percent:85, threshold:80, resetAt:86400000}
 */
export function windowUsage(kind: "day" | "week" | "period", used: number, reserved: number, limit: number, resetAt: number) {
  const percent = limit > 0 ? Math.floor(((used + reserved) * 100) / limit) : 100;
  return { kind, used, reserved, limit, remaining: Math.max(0, limit - used - reserved), percent, threshold: thresholdOf(percent), resetAt };
}

/** Holds that still count at `now` (a hold stops counting when `now >= expiresAt`). */
export const activeHolds = (holds: Hold[] | undefined, now: number) => (holds ?? []).filter((h) => now < h.expiresAt);

/** Normalized settle usage, compared field by field to detect a replay. */
export function settleUsage(usage: any): { credits: number } | { inputTokens: number; outputTokens: number } {
  const integer = (n: unknown, max: number) => {
    if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > max) throw new HttpError(400, "Invalid numeric setting");
    return n as number;
  };
  if (usage && typeof usage === "object" && usage.credits !== undefined && usage.credits !== null)
    return { credits: integer(usage.credits, 1e9) };
  if (usage && typeof usage === "object" && usage.inputTokens !== undefined && usage.inputTokens !== null)
    return { inputTokens: integer(usage.inputTokens, 1e10), outputTokens: integer(usage.outputTokens ?? 0, 1e10) };
  throw new HttpError(400, "Give credits or token usage");
}

/** Same settle usage (a replay) or not (409). */
export const sameUsage = (a: any, b: any) =>
  a?.credits === b?.credits && a?.inputTokens === b?.inputTokens && a?.outputTokens === b?.outputTokens;
