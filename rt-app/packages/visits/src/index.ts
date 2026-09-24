import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  Conflict,
  HttpError,
  type Feature,
} from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL } from "@gsalgadotoledo/rt-app-nosql";
export interface VisitPoint {
  type: "move" | "click" | "scroll" | "page";
  path: string;
  t: number;
  x: number;
  y: number;
}
export interface Visit {
  id: string;
  startedAt: number;
  updatedAt: number;
  sequence: number;
  points: VisitPoint[];
}
const MAX_POINTS = 120,
  MAX_SESSIONS = 10,
  MAX_AGE = 86400000;

/** Tiny diagnostic sample: one atomically replaced document, at most 10 x 120 points. */
export class Visits {
  private rates = new Map<string, { at: number; count: number }>();
  constructor(
    private store: NoSQL,
    private secret: string,
    private pages = ["/", "/about", "/services"],
    private clock = Date.now,
  ) {
    if (secret.length < 32)
      throw new Error(
        "Visits requires a server secret of at least 32 characters",
      );
    if (
      pages.length > 30 ||
      pages.some((path) => !/^\/[a-zA-Z0-9/_-]{0,79}$/.test(path))
    )
      throw new Error("Invalid public visit pages");
  }
  private signature(value: string) {
    return createHmac("sha256", this.secret)
      .update("visits:" + value)
      .digest("base64url");
  }
  private token(value: string): { id: string; startedAt: number } {
    if (typeof value !== "string" || value.length > 500)
      throw new HttpError(400, "Invalid visit token");
    const [payload, signature, ...rest] = value.split("."),
      expected = this.signature(payload ?? "");
    if (
      rest.length ||
      !signature ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new HttpError(400, "Invalid visit token");
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (
        typeof parsed.id !== "string" ||
        !Number.isSafeInteger(parsed.startedAt) ||
        parsed.startedAt > this.clock() ||
        this.clock() - parsed.startedAt > 1800000
      )
        throw 0;
      return parsed;
    } catch {
      throw new HttpError(400, "Expired or invalid visit token");
    }
  }
  /** Limits are per instance; use API Gateway/WAF for public distributed traffic. */
  private rate(ip: string) {
    const now = this.clock();
    for (const [key, value] of this.rates)
      if (now - value.at >= 60000) this.rates.delete(key);
    const key = createHash("sha256").update(ip).digest("hex");
    if (this.rates.size >= 2000 && !this.rates.has(key))
      throw new HttpError(429, "Visits busy");
    const value = this.rates.get(key) ?? { at: now, count: 0 };
    this.rates.set(key, value);
    if (++value.count > 60) throw new HttpError(429, "Visit rate limit");
  }
  start(ip: string) {
    this.rate(ip);
    const payload = Buffer.from(
      JSON.stringify({ id: randomUUID(), startedAt: this.clock() }),
    ).toString("base64url");
    return {
      token: payload + "." + this.signature(payload),
      maxPoints: MAX_POINTS,
      pages: this.pages,
    };
  }
  async ingest(
    input: { token: string; sequence: number; points: VisitPoint[] },
    ip: string,
  ) {
    this.rate(ip);
    const identity = this.token(input.token);
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      !Array.isArray(input.points) ||
      !input.points.length ||
      input.points.length > 20
    )
      throw new HttpError(400, "Invalid visit batch");
    const points = input.points.map((point) => {
      if (
        !point ||
        !["move", "click", "scroll", "page"].includes(point.type) ||
        !this.pages.includes(point.path) ||
        !Number.isSafeInteger(point.t) ||
        point.t < 0 ||
        point.t > 1800000 ||
        !Number.isInteger(point.x) ||
        !Number.isInteger(point.y) ||
        point.x < 0 ||
        point.x > 100 ||
        point.y < 0 ||
        point.y > 100
      )
        throw new HttpError(400, "Invalid visit point");
      return {
        type: point.type,
        path: point.path,
        t: point.t,
        x: point.x,
        y: point.y,
      };
    });
    let recorded = false;
    await this.update((sessions) => {
      let session = sessions.find((value) => value.id === identity.id);
      if (session && input.sequence <= session.sequence) return sessions;
      if (!session) {
        session = {
          ...identity,
          updatedAt: this.clock(),
          sequence: 0,
          points: [],
        };
        sessions.push(session);
      }
      session.sequence = input.sequence;
      session.updatedAt = this.clock();
      session.points.push(
        ...points.slice(0, MAX_POINTS - session.points.length),
      );
      sessions.sort(
        (a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id),
      );
      const retained = sessions.slice(0, MAX_SESSIONS);
      recorded = retained.some((value) => value.id === identity.id);
      return retained;
    });
    return { ok: true, recorded };
  }
  private async update(
    operation: (sessions: Visit[]) => Visit[],
  ): Promise<Visit[]> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.store.get("VISITS", "recent");
      const sessions = (row?.data.sessions ?? []).filter(
        (session: Visit) => session.startedAt > this.clock() - MAX_AGE,
      );
      const next = operation(structuredClone(sessions));
      try {
        await this.store.transact([
          {
            row: {
              pk: "VISITS",
              sk: "recent",
              version: (row?.version ?? 0) + 1,
              ttl: Math.ceil((this.clock() + MAX_AGE) / 1000),
              data: { sessions: next },
            },
            expected: row?.version ?? null,
          },
        ]);
        return next;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 4) throw error;
      }
    }
    throw new HttpError(409, "Visit update conflict");
  }
  async list() {
    const sessions = await this.read();
    return {
      items: sessions.map(({ points, ...session }) => ({
        ...session,
        events: points.length,
        pages: [...new Set(points.map((point) => point.path))],
      })),
      limit: MAX_SESSIONS,
      maxPoints: MAX_POINTS,
    };
  }
  private async read(): Promise<Visit[]> {
    const row = await this.store.get("VISITS", "recent");
    const sessions: Visit[] = row?.data.sessions ?? [];
    if (sessions.some((session) => session.startedAt <= this.clock() - MAX_AGE))
      return this.update((value) => value);
    return sessions;
  }
  async detail(id: string) {
    const session = (await this.read()).find((value) => value.id === id);
    if (!session) throw new HttpError(404, "Visit not found");
    return session;
  }
  async remove(id: string) {
    await this.update((sessions) =>
      sessions.filter((value) => value.id !== id),
    );
    return { ok: true };
  }
  feature(): Feature {
    return {
      id: "visits",
      migrations: [],
      admin: {
        id: "visits",
        title: "Visit sessions",
        resource: "visits.read",
        path: "/visits",
        component: "visits",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        {
          method: "POST",
          path: "/visits/start",
          resource: "visits.capture",
          access: "guest",
          handle: async (c) => this.start(c.request.ip),
        },
        {
          method: "POST",
          path: "/visits/events",
          resource: "visits.capture",
          access: "guest",
          handle: (c) => this.ingest(c.request.body as any, c.request.ip),
        },
        {
          method: "GET",
          path: "/visits",
          resource: "visits.read",
          access: "owner",
          handle: () => this.list(),
        },
        {
          method: "GET",
          path: "/visits/:id",
          resource: "visits.read",
          access: "owner",
          handle: (c) => this.detail(c.params.id),
        },
        {
          method: "DELETE",
          path: "/visits/:id",
          resource: "visits.delete",
          access: "owner",
          handle: (c) => this.remove(c.params.id),
        },
      ],
    };
  }
}
