import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { HttpError, Conflict, epochMs, type Clock, type Row } from "@gsalgadotoledo/rt-app-contracts";

// Refresh sessions: opaque rotating refresh tokens behind 15-minute access JWTs.
// The row formats below are shared with the Python and Go ports (see
// docs/polyglot/auth-sessions.md); change them only together with the contract.

/** Default absolute session lifetime: 4 days from sign-in. */
export const SESSION_TTL_MS = 4 * 24 * 60 * 60 * 1000;

/** How long the immediately previous refresh token stays usable after a rotation. */
export const REFRESH_GRACE_MS = 30_000;

/** `<sessionId>.<secret>`: 16 and 32 random bytes, base64url without padding. */
const REFRESH_TOKEN = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** Every refresh failure answers with this single 401 message (no detail leaks). */
export const INVALID_REFRESH = "Invalid session";

/** Partition holding one user's sessions: SESSIONS#<userId> / <sessionId>. */
export const sessionPartition = (userId: string) => "SESSIONS#" + userId;

/** Pointer partition resolving a session id to its user: SESSION / <sessionId> → {userId}. */
export const SESSION_INDEX = "SESSION";

export interface SessionOptions {
  /** Injectable clock (epoch ms or Date); defaults to the system clock. */
  now?: Clock;
  /** Absolute session lifetime in ms (default 4 days). */
  ttlMs?: number;
  /** Grace window for reusing the previous refresh token in ms (default 30 s). */
  graceMs?: number;
}

/** Who a session belongs to and what must still hold for it to be valid. */
export interface SessionSubject {
  id: string;
  tokenVersion: number;
  /** Credential provider at sign-in ("local", "cognito", "admin:<fingerprint>"...). */
  provider: string;
}

/** Client details stored for the session list (sanitized, never used for authorization). */
export interface SessionClient {
  ip?: string | null;
  userAgent?: string | null;
}

/** A newly issued or rotated refresh token. */
export interface IssuedRefresh {
  sessionId: string;
  refreshToken: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  row: Row;
}

/** Keep printable ASCII only (U+0020–U+007E), cut to max characters; empty → null. */
export function clientText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return text || null;
}

/** Split a refresh token into its session id and secret, or undefined when malformed. */
export function parseRefreshToken(token: unknown) {
  if (typeof token !== "string") return undefined;
  const match = REFRESH_TOKEN.exec(token);
  return match ? { sessionId: match[1], secret: match[2] } : undefined;
}

/** A session is live until it is revoked or reaches its absolute expiry (expiresAt <= now is dead). */
export function sessionLive(row: Row | undefined, now: number): row is Row {
  return !!row && row.data.revokedAt == null && now < row.data.expiresAt;
}

/**
 * Store-backed refresh sessions. Only HMACs of secrets are stored; the previous hash is kept
 * for the concurrent-tab grace window and to detect reuse (theft), which revokes the session.
 */
export class RefreshSessions {
  constructor(
    private store: Store,
    private secret: string,
    private options: SessionOptions = {},
  ) {}

  private now() {
    return epochMs(this.options.now);
  }

  get ttlMs() {
    return this.options.ttlMs ?? SESSION_TTL_MS;
  }

  private get graceMs() {
    return this.options.graceMs ?? REFRESH_GRACE_MS;
  }

  /** hex(HMAC-SHA256(app secret, "refresh:<sessionId>:<secret>")). */
  hash(sessionId: string, secret: string) {
    return createHmac("sha256", this.secret).update(`refresh:${sessionId}:${secret}`).digest("hex");
  }

  private matches(stored: unknown, presented: string) {
    return (
      typeof stored === "string" &&
      stored.length === presented.length &&
      timingSafeEqual(Buffer.from(stored), Buffer.from(presented))
    );
  }

  /**
   * Start a session for a subject that just signed in. Writes the session row and its pointer
   * atomically; both expire (TTL) at the absolute expiry.
   * @example create({id: "u-1", tokenVersion: 1, provider: "local"}, {ip: "1.1.1.1"})
   *   → {sessionId: "Qm9…", refreshToken: "Qm9….c2Vj…", expiresAt: now + 4 days}
   */
  async create(subject: SessionSubject, client: SessionClient = {}): Promise<IssuedRefresh> {
    const now = this.now(),
      sessionId = randomBytes(16).toString("base64url"),
      secret = randomBytes(32).toString("base64url"),
      expiresAt = now + this.ttlMs,
      ttl = Math.floor(expiresAt / 1000);
    const row: Row = {
      pk: sessionPartition(subject.id),
      sk: sessionId,
      version: 1,
      ttl,
      data: {
        userId: subject.id,
        provider: subject.provider,
        tokenVersion: subject.tokenVersion,
        secretHash: this.hash(sessionId, secret),
        previousHash: null,
        rotatedAt: now,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
        revokedAt: null,
        revokedReason: null,
        ip: clientText(client.ip, 64),
        userAgent: clientText(client.userAgent, 200),
      },
    };
    await this.store.transact([
      { row: { pk: SESSION_INDEX, sk: sessionId, version: 1, ttl, data: { userId: subject.id } }, expected: null },
      { row, expected: null },
    ]);
    return { sessionId, refreshToken: `${sessionId}.${secret}`, expiresAt, row };
  }

  /** The session row of an id through its pointer, or undefined. */
  async find(sessionId: string) {
    const pointer = await this.store.get(SESSION_INDEX, sessionId);
    if (typeof pointer?.data.userId !== "string") return undefined;
    return this.store.get(sessionPartition(pointer.data.userId), sessionId);
  }

  /** The row of one user's session (one read), or undefined. */
  get(userId: string, sessionId: string) {
    return this.store.get(sessionPartition(userId), sessionId);
  }

  /**
   * Rotate a refresh token. `valid(row)` re-checks the subject in the database (user active,
   * same provider and tokenVersion). Returns the new token for the same session and expiry.
   * Throws 401 "Invalid session" for anything invalid; reusing a superseded token (other
   * than the previous one inside the grace window) revokes the whole session first.
   * Concurrent rotations are version-guarded; a loser re-reads and normally lands in the grace path.
   * `blocked(row, holder)` runs first on any existing row (live or not) and may throw to refuse
   * with another error; holder tells whether the token's secret is the current or previous one.
   */
  async rotate(
    token: unknown,
    valid: (row: Row) => Promise<boolean>,
    blocked?: (row: Row, holder: boolean) => Promise<void>,
  ): Promise<IssuedRefresh> {
    const parsed = parseRefreshToken(token);
    if (!parsed) throw new HttpError(401, INVALID_REFRESH);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.find(parsed.sessionId), now = this.now();
      const presented = this.hash(parsed.sessionId, parsed.secret);
      // Before liveness: a banned account answers 403 to whoever holds this session's current or
      // previous secret (the hook throws), even though the ban already revoked the session.
      if (row && blocked)
        await blocked(row, this.matches(row.data.secretHash, presented) || this.matches(row.data.previousHash, presented));
      if (!sessionLive(row, now) || !(await valid(row))) throw new HttpError(401, INVALID_REFRESH);
      let data: Record<string, unknown>;
      if (this.matches(row.data.secretHash, presented)) {
        // Normal rotation: the presented secret becomes the previous one.
        data = { previousHash: row.data.secretHash, rotatedAt: now };
      } else if (this.matches(row.data.previousHash, presented) && now - row.data.rotatedAt <= this.graceMs) {
        // A sibling tab raced us with the same token: issue another secret, keep the grace window.
        data = {};
      } else {
        // A superseded or forged secret for a live session: assume theft and revoke everything.
        try {
          await this.write(row, { revokedAt: now, revokedReason: "reuse" });
        } catch (error) {
          if (error instanceof Conflict) continue;
          throw error;
        }
        throw new HttpError(401, INVALID_REFRESH);
      }
      const secret = randomBytes(32).toString("base64url");
      try {
        const next = await this.write(row, { ...data, secretHash: this.hash(parsed.sessionId, secret), lastUsedAt: now });
        return { sessionId: parsed.sessionId, refreshToken: `${parsed.sessionId}.${secret}`, expiresAt: row.data.expiresAt, row: next };
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    throw new Conflict();
  }

  /** Version-guarded update of a session row; throws Conflict when it changed meanwhile. */
  private async write(row: Row, changes: Record<string, unknown>) {
    const next = { ...row, version: row.version + 1, data: { ...row.data, ...changes } };
    await this.store.transact([{ row: next, expected: row.version }]);
    return next;
  }

  /**
   * Revoke one live session of a user. Returns false when it does not exist, belongs to
   * another user or is already revoked or expired.
   */
  async revoke(userId: string, sessionId: string, reason: string) {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 100) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await this.get(userId, sessionId);
      if (!sessionLive(row, this.now())) return false;
      try {
        await this.write(row, { revokedAt: this.now(), revokedReason: reason });
        return true;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    throw new Conflict();
  }

  /**
   * Revoke every live session of a user with reason (for example "ban"). Returns how many were
   * revoked. Each session is a separate version-guarded write, so this is not atomic; callers
   * bump the user's tokenVersion first, which already makes every session unusable.
   */
  async revokeAll(userId: string, reason: string) {
    let revoked = 0;
    const now = this.now();
    for (const row of await this.rows(userId))
      if (sessionLive(row, now) && (await this.revoke(userId, row.sk, reason))) revoked++;
    return revoked;
  }

  /** Every stored session row of a user, across all pages (live or not). */
  async rows(userId: string) {
    const rows: Row[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(sessionPartition(userId), cursor);
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return rows;
  }
}
