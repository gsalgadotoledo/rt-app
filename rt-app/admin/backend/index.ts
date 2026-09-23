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
/** A password-only root principal. No admin users, profiles, migrations or database. */
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
  private attempts = new Map<string, { count: number; until: number }>();
  private pending = 0;
  constructor(
    private verifier: string | undefined,
    secret: string,
    private localAccess = false,
  ) {
    if (verifier) validateVerifier(verifier);
    const signing = createHmac("sha256", secret)
      .update("rt-app:root:" + (verifier ?? "disabled"))
      .digest("hex");
    this.tokens = new JwtTokens(signing, "rt-app-admin", "rt-app-admin-api");
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
        if (claim.id !== "rt-app-root")
          throw new HttpError(401, "Invalid admin session");
        return {
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
            path: "/admin/identity/auth/logout",
            resource: "admin.logout",
            access: "authenticated",
            handle: async () => ({ ok: true }),
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
    return {
      token: await this.tokens.issue({ id: "rt-app-root", tokenVersion: 0 }),
      user: { id: "rt-app-root", name: "Root", role: "owner" },
    };
  }
}
