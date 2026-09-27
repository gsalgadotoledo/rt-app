import {
  HttpError,
  Conflict,
  auditUpdate,
  epochMs,
  type Actor,
  type Clock,
  type Data,
  type Feature,
  type Row,
} from "@gsalgadotoledo/rt-app-contracts";
import {
  Users,
  activeBan,
  parseInstant,
  viewAccount,
  MAX_INSTANT_MS,
  type StoredBan,
} from "@gsalgadotoledo/rt-app-users";
import { migrations } from "./migrations.js";

// Account bans: an extension of the users module. The ban itself lives on the USERS row
// (data.ban, read by activeBan in rt-app-users and enforced by rt-app-auth on every sign-in,
// refresh and request); this module writes it, keeps the append-only audit history and serves
// the admin endpoints. Row formats and algorithms: docs/polyglot/users-bans.md and
// spec/contracts/users-bans.contract.yaml (shared with the Python and Go ports).

/** The admin root principal (ADMIN_PASSWORD). Only it can ban or unban an owner. */
export const ROOT_ACTOR = "rt-app-root";

/** Partition of a user's ban history: USER_BANS#<userId> / pad15(atMs)-pad10(user row version). */
export const banPartition = (userId: string) => "USER_BANS#" + userId;

/** Revocation reason written on the refresh sessions a ban ends. */
export const BAN_SESSION_REASON = "ban";

const CATEGORY = /^[a-z][a-z0-9_-]{0,39}$/;

/** Writes a version-guarded transaction retries before giving up with 409. */
const ATTEMPTS = 4;

/** Ends the refresh sessions of a user (rt-app-auth RefreshSessions.revokeAll). */
export interface SessionRevoker {
  revokeAll(userId: string, reason: string): Promise<number>;
}

export interface UserBansOptions {
  /** Injectable clock (epoch ms or Date); defaults to the system clock. Share it with Auth. */
  now?: Clock;
  /** Marks the user's refresh sessions revoked with reason "ban" after the ban is stored. */
  sessions?: SessionRevoker;
}

/** What a ban or unban request carries. Only reason is read by unban. */
export interface BanInput {
  reason?: unknown;
  until?: unknown;
  category?: unknown;
}

/** One audit row of the history, as GET /users/:id/bans returns it. */
export interface BanHistoryItem {
  id: string;
  userId: string;
  action: "ban" | "update" | "unban";
  reason: string;
  category: string | null;
  until: string | null;
  actorId: string;
  at: string;
}

type BanActor = Pick<Actor, "id" | "role">;

/**
 * A required reason: a string whose JavaScript trim() has 3 to 500 UTF-16 units, else 400.
 * @example banReason("  Spam  ") // → "Spam"
 */
export function banReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 3 || reason.length > 500)
    throw new HttpError(400, "A reason of 3 to 500 characters is required");
  return reason;
}

/**
 * Optional end of a temporary ban: null/undefined → permanent (null); otherwise a strict ISO 8601
 * instant (parseInstant) after now, returned normalized with milliseconds and Z.
 * @example banUntil("2026-02-01T00:00:00+01:00", now) // → "2026-01-31T23:00:00.000Z"
 */
export function banUntil(value: unknown, nowMs: number) {
  if (value == null) return null;
  const ms = parseInstant(value);
  if (ms === undefined) throw new HttpError(400, "Invalid until: use an ISO 8601 date and time");
  if (ms <= nowMs) throw new HttpError(400, "until must be in the future");
  return new Date(ms).toISOString();
}

/** Optional label for filtering: null/undefined → null, else ^[a-z][a-z0-9_-]{0,39}$ or 400. */
export function banCategory(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "string" || !CATEGORY.test(value)) throw new HttpError(400, "Invalid category");
  return value;
}

/** pad15(epoch ms) + "-" + pad10(version): sort keys in time order, unique per user row version. */
function historyKey(atMs: number, version: number) {
  return String(atMs).padStart(15, "0") + "-" + String(version).padStart(10, "0");
}

export class UserBans {
  constructor(
    private users: Users,
    private options: UserBansOptions = {},
  ) {}

  private get store() {
    return this.users.store;
  }

  private now() {
    return epochMs(this.options.now);
  }

  /** A user row that exists and is not deleted; ids that are not short strings are never read. */
  private async target(userId: unknown) {
    const row = typeof userId === "string" && userId.length <= 100 ? await this.users.get(userId) : undefined;
    if (!row || row.data.deletedAt) throw new HttpError(404, "User not found");
    return row;
  }

  /**
   * Who may ban or unban whom (verb is "ban" or "unban"): never yourself; an owner only by the
   * admin root; an administrator only by an owner (or the root). The endpoint permission
   * (users.ban) is checked before, by the ACL.
   */
  private authorize(row: Row, actor: BanActor, verb: "ban" | "unban") {
    if (row.data.id === actor.id) throw new HttpError(403, `You cannot ${verb} your own account`);
    if (row.data.role === "owner" && actor.id !== ROOT_ACTOR)
      throw new HttpError(403, `Only the admin root can ${verb} an owner`);
    if (row.data.role === "admin" && actor.role !== "owner")
      throw new HttpError(403, `Only an owner can ${verb} an administrator`);
  }

  /**
   * Store the next user row and its audit row in one transaction (both or neither). Retries on
   * a concurrent change of the user row, re-reading and re-checking it (4 attempts, then 409).
   */
  private async write(
    userId: unknown,
    actor: BanActor,
    verb: "ban" | "unban",
    change: (row: Row, nowMs: number) => { data: Data; audit: Omit<BanHistoryItem, "id" | "userId" | "actorId" | "at"> },
  ) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const row = await this.target(userId);
      this.authorize(row, actor, verb);
      const nowMs = this.now(), at = new Date(nowMs);
      const { data, audit } = change(row, nowMs);
      const next: Row = {
        ...row,
        version: row.version + 1,
        data: { ...data, ...auditUpdate(actor.id, at) },
      };
      const history: Row = {
        pk: banPartition(row.data.id),
        sk: historyKey(nowMs, next.version),
        version: 1,
        data: { userId: row.data.id, ...audit, actorId: actor.id, at: at.toISOString() },
      };
      try {
        await this.store.transact([
          { row: next, expected: row.version },
          { row: history, expected: null },
        ]);
        return { row: next, nowMs };
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    throw new Conflict();
  }

  /**
   * Ban (suspend) an account at once. Validates reason, until and category (400), then the user
   * (404) and who may ban them (403). In one transaction: data.ban = {reason, category, until, at,
   * by}, tokenVersion + 1 (every access token and refresh session stops working) and an audit row
   * (action "ban", or "update" when a ban was already in force: re-banning replaces reason, until
   * and category). Afterwards the user's live refresh sessions are marked revoked ("ban").
   * Returns the admin view of the account.
   * @example ban("u-1", {reason: "Chargeback fraud", until: "2026-02-01T00:00:00Z"}, {id: "rt-app-root", role: "owner"})
   *   → {id: "u-1", …, banned: true, ban: {reason: "Chargeback fraud", category: null, until: "2026-02-01T00:00:00.000Z", at, by: "rt-app-root"}}
   */
  async ban(userId: unknown, input: BanInput, actor: BanActor) {
    const body = input && typeof input === "object" ? input : {};
    const reason = banReason(body.reason);
    const until = banUntil(body.until, this.now());
    const category = banCategory(body.category);
    const { row, nowMs } = await this.write(userId, actor, "ban", (current, nowMs) => {
      const ban: StoredBan = { reason, category, until, at: new Date(nowMs).toISOString(), by: actor.id };
      return {
        data: { ...current.data, ban, tokenVersion: current.data.tokenVersion + 1 },
        audit: { action: activeBan(current.data, nowMs) ? "update" : "ban", reason, category, until },
      };
    });
    // The tokenVersion bump already cut every session; this records why on each session row.
    await this.options.sessions?.revokeAll(row.data.id, BAN_SESSION_REASON);
    return viewAccount(row.data, nowMs);
  }

  /**
   * Lift the ban in force (409 "User is not banned" otherwise, including a temporary ban that has
   * already expired). Same validation of reason and the same rules as ban. Writes data.ban =
   * null and an audit row (action "unban"); tokenVersion is NOT changed: sessions ended by the ban
   * stay ended and the user signs in again. Returns the admin view of the account.
   */
  async unban(userId: unknown, input: BanInput, actor: BanActor) {
    const body = input && typeof input === "object" ? input : {};
    const reason = banReason(body.reason);
    const { row, nowMs } = await this.write(userId, actor, "unban", (current, nowMs) => {
      if (!activeBan(current.data, nowMs)) throw new HttpError(409, "User is not banned");
      return {
        data: { ...current.data, ban: null },
        audit: { action: "unban", reason, category: null, until: null },
      };
    });
    return viewAccount(row.data, nowMs);
  }

  /**
   * The append-only ban history of a user, newest first ({items}); 404 when the user row does
   * not exist (deleted users keep their history).
   */
  async history(userId: unknown) {
    const row = typeof userId === "string" && userId.length <= 100 ? await this.users.get(userId) : undefined;
    if (!row) throw new HttpError(404, "User not found");
    const rows: Row[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(banPartition(row.data.id), cursor);
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    const items: BanHistoryItem[] = rows
      .sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0))
      .map((r) => ({
        id: r.sk,
        userId: r.data.userId,
        action: r.data.action,
        reason: r.data.reason,
        category: r.data.category ?? null,
        until: r.data.until ?? null,
        actorId: r.data.actorId,
        at: r.data.at,
      }));
    return { items };
  }

  /** Endpoints: ban and unban (users.ban), history (users.bans.read); published as admin tools. */
  feature(): Feature {
    return {
      id: "users-bans",
      migrations,
      endpoints: [
        {
          method: "POST",
          path: "/users/:id/ban",
          resource: "users.ban",
          access: "permission",
          tool: {
            name: "users_ban",
            description:
              "Suspend an application account at once: its sessions and access tokens stop working and sign-in, codes and refresh answer 403 Account suspended. params.id and body.reason (3-500 characters, kept in the admin history, never shown to the user) are required; body.until (ISO 8601, in the future) makes the ban temporary and it lifts by itself at that instant; body.category is an optional label (^[a-z][a-z0-9_-]{0,39}$). Banning a banned account replaces reason, until and category (history action update). Owners can be banned only by the admin root, administrators only by owners; nobody bans themselves.",
            example: { params: { id: "user-123" }, body: { reason: "Chargeback fraud reported by the bank", until: "2026-12-31T00:00:00Z", category: "fraud" } },
          },
          handle: (c) => this.ban(c.params.id, c.request.body, c.actor!),
        },
        {
          method: "POST",
          path: "/users/:id/unban",
          resource: "users.ban",
          access: "permission",
          tool: {
            name: "users_unban",
            description:
              "Lift the ban in force on an application account (409 when it is not banned, also after a temporary ban expired). params.id and body.reason (3-500 characters) are required. Sessions ended by the ban stay ended: the user signs in again.",
            example: { params: { id: "user-123" }, body: { reason: "Bank confirmed the payment" } },
          },
          handle: (c) => this.unban(c.params.id, c.request.body, c.actor!),
        },
        {
          method: "GET",
          path: "/users/:id/bans",
          resource: "users.bans.read",
          access: "permission",
          tool: {
            name: "users_bans",
            description:
              "Ban history of an application account, newest first: {items: [{id, userId, action (ban | update | unban), reason, category, until, actorId, at}]}. Append-only. params.id is required.",
            example: { params: { id: "user-123" } },
          },
          handle: (c) => this.history(c.params.id),
        },
      ],
    };
  }
}

export { MAX_INSTANT_MS };
