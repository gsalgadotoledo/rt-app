import { createHmac } from "node:crypto";
import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { HttpError, Conflict } from "@gsalgadotoledo/rt-app-contracts";

/**
 * Fixed one-minute window counter: row RATE/hex(HMAC(secret, "<key>:<floor(now/60000)>")) {count}
 * with ttl now+120 s. Throws 429 "Too many attempts; wait one minute" when count >= max (a refused
 * attempt is not counted); version-guarded with 8 retries, then 429 "Too many simultaneous attempts".
 */
export async function rateLimit(store: Store, secret: string, now: number, key: string, max: number) {
  const window = Math.floor(now / 60000);
  const sk = createHmac("sha256", secret).update(`${key}:${window}`).digest("hex");
  for (let i = 0; i < 8; i++) {
    const row = await store.get("RATE", sk);
    if ((row?.data.count ?? 0) >= max)
      throw new HttpError(429, "Too many attempts; wait one minute");
    try {
      await store.transact([
        {
          row: {
            pk: "RATE",
            sk,
            version: (row?.version ?? 0) + 1,
            data: { count: (row?.data.count ?? 0) + 1 },
            ttl: Math.floor(now / 1000) + 120,
          },
          expected: row?.version ?? null,
        },
      ]);
      return;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }
  throw new HttpError(429, "Too many simultaneous attempts");
}
