import { SignJWT, jwtVerify } from "jose";
import { HttpError, epochMs, type Clock } from "@gsalgadotoledo/rt-app-contracts";
export interface JwtOptions {
  /** Injectable clock (epoch ms or Date) for iat/exp and expiry checks; defaults to the system clock. */
  now?: Clock;
}
/** Verified claims: sub, the token version and, for tokens tied to a refresh session, its id. */
export interface JwtClaims {
  id: string;
  version: number;
  sid?: string;
}
export class JwtTokens {
  private key: Uint8Array;
  constructor(
    secret: string,
    private issuer = "rt-app",
    private audience = "rt-app-api",
    private options: JwtOptions = {},
  ) {
    if (Buffer.byteLength(secret) < 32)
      throw new Error("JWT_SECRET must contain at least 32 bytes");
    this.key = new TextEncoder().encode(secret);
  }

  /**
   * Sign a 15-minute access token. user.id becomes sub and tokenVersion (v) enables server-side
   * revocation. An optional non-empty user.sid ties the token to a refresh session: the payload is
   * then {v, sid, sub, iss, aud, iat, exp} in that order; without it the token is byte-identical to
   * earlier releases.
   */
  async issue(user: { id: string; tokenVersion: number; sid?: string }) {
    const now = Math.floor(epochMs(this.options.now) / 1000);
    const claims: Record<string, unknown> = { v: user.tokenVersion };
    if (typeof user.sid === "string" && user.sid) claims.sid = user.sid;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(this.key);
  }

  /**
   * Return {id, version} plus sid when the token carries one; malformed, expired or
   * foreign-audience tokens, and a sid that is not a non-empty string, always yield HTTP 401.
   */
  async verify(token: string): Promise<JwtClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ["exp", "iat", "sub"],
        currentDate: new Date(epochMs(this.options.now)),
      });
      if (!payload.sub || !Number.isInteger(payload.v)) throw 0;
      if (payload.sid !== undefined && (typeof payload.sid !== "string" || !payload.sid)) throw 0;
      return {
        id: payload.sub,
        version: payload.v as number,
        ...(payload.sid === undefined ? {} : { sid: payload.sid as string }),
      };
    } catch {
      throw new HttpError(401, "Invalid or expired session");
    }
  }
}
