import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  HttpError,
  type Actor,
  type Endpoint,
  type Feature,
} from "@gsalgadotoledo/rt-app-contracts";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import {
  RefreshSessions,
  parseRefreshToken,
  rateLimit,
  sessionLive,
  INVALID_REFRESH,
} from "@gsalgadotoledo/rt-app-auth";
const scrypt = promisify(scryptCallback);
export async function passwordVerifier(password: string) {
  if (
    typeof password !== "string" ||
    password.length < 16 ||
    password.length > 128
  )
    throw new Error("ADMIN_PASSWORD must contain 16–128 characters");
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export function validateVerifier(value: string) {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value))
    throw new Error("Invalid admin password verifier");
  return value;
}
const ROOT = "rt-app-root";

/**
 * A password-only root principal. No admin users, profiles or migrations. Without a store it is
 * fully stateless (15-minute tokens, as before). With a store, sign-in also starts a refresh
 * session (rows SESSIONS#rt-app-root/<id>, same format as application sessions) so the admin
 * console stays signed in for up to 4 days; changing ADMIN_PASSWORD ends every root session.
 */
export class AdminIdentity {
  readonly features: Feature[];
  readonly auth: {
    actor: (authorization?: string) => Promise<Actor | undefined>;
  };
  readonly acl = {
    allows: (actor: Actor | undefined, _resource: string) =>
      actor?.id === "rt-app-root" && actor.role === "owner",
    check: (endpoint: Endpoint, actor?: Actor) => {
      if (endpoint.access !== "guest" && actor?.id !== "rt-app-root")
        throw new HttpError(401, "Sign in to admin");
    },
  };
  private tokens: JwtTokens;
  private sessions?: RefreshSessions;
  /** Binds root sessions to the current ADMIN_PASSWORD verifier. */
  private provider: string;
  private attempts = new Map<string, { count: number; until: number }>();
  private pending = 0;
  constructor(
    private verifier: string | undefined,
    secret: string,
    private localAccess = false,
    private store?: Store,
  ) {
    if (verifier) validateVerifier(verifier);
    const signing = createHmac("sha256", secret)
      .update("rt-app:root:" + (verifier ?? "disabled"))
      .digest("hex");
    this.tokens = new JwtTokens(signing, "rt-app-admin", "rt-app-admin-api");
    this.provider = "admin:" + createHmac("sha256", secret)
      .update("rt-app:root-sessions:" + (verifier ?? "disabled"))
      .digest("hex")
      .slice(0, 16);
    this.secret = secret;
    if (store) this.sessions = new RefreshSessions(store, secret);
    this.auth = {
      actor: async (header) => {
        if (this.localAccess) return {
          id: "rt-app-root", role: "owner", grants: [], email: "",
          name: "Local administrator", tokenVersion: 0, active: true,
        };
        if (!header) return undefined;
        if (!this.verifier || !header.startsWith("Bearer "))
          throw new HttpError(401, "Invalid admin session");
        const claim = await this.tokens.verify(header.slice(7));
        if (claim.id !== ROOT)
          throw new HttpError(401, "Invalid admin session");
        // A token tied to a root session dies with it (logout, expiry, password change).
        if (claim.sid !== undefined) {
          const row = await this.sessions?.get(ROOT, claim.sid);
          if (!sessionLive(row, Date.now()) || row.data.provider !== this.provider)
            throw new HttpError(401, "Invalid admin session");
        }
        return {
          ...(claim.sid === undefined ? {} : { sessionId: claim.sid }),
          id: "rt-app-root",
          role: "owner",
          grants: [],
          email: "",
          name: "Root",
          tokenVersion: 0,
          active: true,
        };
      },
    };
    this.features = [
      {
        id: "admin-root",
        migrations: [],
        endpoints: [
          {
            method: "POST",
            path: "/admin/identity/auth/login",
            resource: "admin.login",
            access: "guest",
            handle: (c) =>
              this.login(c.request.body.password, c.request.ip ?? "unknown"),
          },
          {
            method: "POST",
            path: "/admin/identity/auth/refresh",
            resource: "admin.refresh",
            access: "guest",
            handle: (c) =>
              this.refresh(c.request.body.refreshToken, c.request.ip ?? "unknown"),
          },
          {
            method: "POST",
            path: "/admin/identity/auth/logout",
            resource: "admin.logout",
            access: "authenticated",
            handle: async (c) => {
              // Ends the current root session; stateless tokens simply expire.
              if (c.actor?.sessionId) await this.sessions?.revoke(ROOT, c.actor.sessionId, "logout");
              return { ok: true };
            },
          },
        ],
      },
    ];
  }
  async login(password: unknown, ip: string) {
    if (!this.verifier)
      throw new HttpError(
        503,
        "Configure ADMIN_PASSWORD before starting admin",
      );
    const now = Date.now();
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) ?? { count: 0, until: now + 60000 };
    if (
      attempt.count >= 5 ||
      this.pending >= 4 ||
      (!this.attempts.has(ip) && this.attempts.size >= 1000)
    )
      throw new HttpError(429, "Try again later");
    attempt.count++;
    this.attempts.set(ip, attempt);
    if (typeof password !== "string" || password.length > 128)
      throw new HttpError(401, "Invalid password");
    this.pending++;
    try {
      const [, salt, hash] = this.verifier.split(":");
      const candidate = (await scrypt(password, salt, 64)) as Buffer;
      if (!timingSafeEqual(candidate, Buffer.from(hash, "hex")))
        throw new HttpError(401, "Invalid password");
    } finally {
      this.pending--;
    }
    this.attempts.delete(ip);
    if (!this.sessions)
      return {
        token: await this.tokens.issue({ id: ROOT, tokenVersion: 0 }),
        expiresIn: 900,
        user: { id: ROOT, name: "Root", role: "owner" },
      };
    return this.respond(
      await this.sessions.create({ id: ROOT, tokenVersion: 0, provider: this.provider }, { ip }),
    );
  }

  private secret: string;

  /** Root session response: same shape as application sessions. */
  private async respond(refresh: { sessionId: string; refreshToken: string; expiresAt: number }) {
    return {
      token: await this.tokens.issue({ id: ROOT, tokenVersion: 0, sid: refresh.sessionId }),
      expiresIn: 900,
      refreshToken: refresh.refreshToken,
      refreshExpiresAt: new Date(refresh.expiresAt).toISOString(),
      sessionId: refresh.sessionId,
      user: { id: ROOT, name: "Root", role: "owner" },
    };
  }

  /**
   * POST /admin/identity/auth/refresh: rotate a root refresh token (same rules as application
   * refresh: grace window, reuse revokes the session). 401 "Invalid session" on any failure,
   * including when no store is configured or ADMIN_PASSWORD changed.
   */
  async refresh(refreshToken: unknown, ip: string) {
    if (!this.sessions || !this.store) throw new HttpError(401, INVALID_REFRESH);
    await rateLimit(this.store, this.secret, Date.now(), `admin-refresh-ip:${ip}`, 30);
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new HttpError(401, INVALID_REFRESH);
    await rateLimit(this.store, this.secret, Date.now(), `admin-refresh-session:${parsed.sessionId}`, 10);
    const rotated = await this.sessions.rotate(
      refreshToken,
      async (row) => row.data.userId === ROOT && row.data.provider === this.provider && row.data.tokenVersion === 0 && !!this.verifier,
    );
    return this.respond(rotated);
  }
}
