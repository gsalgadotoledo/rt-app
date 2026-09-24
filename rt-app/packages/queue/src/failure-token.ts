import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";

/** Sealed short-lived SQS receipts work across API instances sharing the configured server secret. */
export class FailureTokens {
  private key: Buffer;
  constructor(
    secret: string,
    private scope: string,
    private clock = Date.now,
  ) {
    if (secret.length < 32)
      throw new TypeError(
        "Queue admin secret must contain at least 32 characters",
      );
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(value: unknown, expires: number): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(this.scope));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify({ value, expires })),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
      "base64url",
    );
  }

  open(token: string): unknown {
    try {
      if (typeof token !== "string" || token.length > 400000)
        throw new Error("Invalid token");
      const bytes = Buffer.from(token, "base64url"),
        decipher = createDecipheriv(
          "aes-256-gcm",
          this.key,
          bytes.subarray(0, 12),
        );
      decipher.setAAD(Buffer.from(this.scope));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const data = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (!Number.isFinite(data.expires) || data.expires <= this.clock())
        throw new Error("Expired");
      return data.value;
    } catch {
      throw new HttpError(
        409,
        "Inspection expired or invalid; load messages again",
      );
    }
  }
}
