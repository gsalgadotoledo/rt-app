import { viewUser, type Data } from "@gsalgadotoledo/rt-app-contracts";

// Account suspension (bans) as stored on the USERS row. The users module owns the row format and
// this reader, so every sign-in path (auth, in every language) enforces a ban even when the
// users-bans module that writes them is not enabled. Row format and algorithm:
// docs/polyglot/users-bans.md; change them only together with users-bans.contract.yaml.

/** The single public message of every refused sign-in, refresh or request of a banned account. */
export const ACCOUNT_SUSPENDED = "Account suspended";

/** The ban stored at USERS/<id>.data.ban (null or missing when the account is not banned). */
export interface StoredBan {
  reason: string;
  category: string | null;
  /** End of a temporary ban (ISO 8601, milliseconds, Z); null for a permanent ban. */
  until: string | null;
  /** When the ban was written (ISO 8601) and by whom (actor id). */
  at: string;
  by: string;
}

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Latest instant accepted: 9999-12-31T23:59:59.999Z (keeps toISOString at four year digits). */
export const MAX_INSTANT_MS = 253402300799999;

function daysInMonth(year: number, month: number) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Strict ISO 8601 instant → epoch ms, or undefined. The same grammar in every language (never
 * Date.parse, whose leniency differs): YYYY-MM-DDTHH:MM:SS, optional .f to .fff, then Z or ±HH:MM;
 * a real calendar date, year 1970 or later, at most MAX_INSTANT_MS once the offset is applied.
 * @example parseInstant("2026-01-02T03:04:05+01:00") // → 1767319445000
 */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = INSTANT.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const fraction = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHours = Number(match[10] ?? 0), offsetMinutes = Number(match[11] ?? 0);
  if (
    year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59
  )
    return undefined;
  const sign = match[9] === "-" ? -1 : 1;
  const ms =
    Date.UTC(year, month - 1, day, hour, minute, second, fraction) -
    sign * (offsetHours * 60 + offsetMinutes) * 60000;
  return ms >= 0 && ms <= MAX_INSTANT_MS ? ms : undefined;
}

/**
 * The ban in force on a user row at nowMs, or null. A ban with until null is permanent; a
 * temporary one lifts by itself when until <= now (the JWT exp boundary rule, nothing is written).
 * An until that cannot be read keeps the ban in force (fail closed).
 * @example activeBan({ban: {reason: "Spam", until: "2026-01-02T00:00:00.000Z", …}}, Date.parse("2026-01-02T00:00:00.000Z")) // → null
 */
export function activeBan(data: Data | undefined, nowMs: number): StoredBan | null {
  const ban = data?.ban;
  if (!ban || typeof ban !== "object" || Array.isArray(ban)) return null;
  if (ban.until != null) {
    const until = parseInstant(ban.until);
    if (until !== undefined && until <= nowMs) return null;
  }
  return {
    reason: ban.reason ?? null,
    category: ban.category ?? null,
    until: ban.until ?? null,
    at: ban.at ?? null,
    by: ban.by ?? null,
  };
}

/**
 * The admin view of an account (GET /users, GET /users/:id): viewUser plus the ban status.
 * `ban` is the ban in force (reason included: only administrators read this view) or null.
 */
export function viewAccount(data: Data, nowMs: number) {
  const ban = activeBan(data, nowMs);
  return { ...viewUser(data), banned: ban !== null, ban };
}
