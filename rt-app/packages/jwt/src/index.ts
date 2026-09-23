import { SignJWT, jwtVerify } from "jose";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";
export class JwtTokens {
  private key: Uint8Array;
  constructor(
    secret: string,
    private issuer = "rt-app",
    private audience = "rt-app-api",
  ) {
    if (Buffer.byteLength(secret) < 32)
      throw new Error("JWT_SECRET must contain at least 32 bytes");
    this.key = new TextEncoder().encode(secret);
  }
  async issue(user: { id: string; tokenVersion: number }) {
    return new SignJWT({ v: user.tokenVersion })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(this.key);
  }
  async verify(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: ["exp", "iat", "sub"],
      });
      if (!payload.sub || !Number.isInteger(payload.v)) throw 0;
      return { id: payload.sub, version: payload.v as number };
    } catch {
      throw new HttpError(401, "Invalid or expired session");
    }
  }
}
