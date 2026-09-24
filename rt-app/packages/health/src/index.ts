import { HttpError, type Feature } from "@gsalgadotoledo/rt-app-contracts";
export interface HealthProbe {
  id: string;
  required?: boolean;
  check(signal: AbortSignal): Promise<void>;
}
export interface HealthReport {
  ok: boolean;
  at: string;
  checks: Array<{
    id: string;
    required: boolean;
    status: "up" | "down";
    durationMs: number;
  }>;
}

/** Cached, bounded probes; failures never expose provider credentials or error bodies. */
export class HealthChecks {
  private snapshot?: HealthReport;
  private expires = 0;
  private pending?: Promise<HealthReport>;
  constructor(
    private probes: HealthProbe[] = [],
    private timeoutMs = 1000,
    private cacheMs = 10000,
  ) {
    if (
      probes.length > 20 ||
      new Set(probes.map((probe) => probe.id)).size !== probes.length ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isFinite(cacheMs) ||
      cacheMs < 0
    )
      throw new TypeError("Invalid health configuration");
  }
  /** Return a cloned snapshot; concurrent callers share one bounded probe run. */
  async report(): Promise<HealthReport> {
    if (this.snapshot && this.expires > Date.now())
      return structuredClone(this.snapshot);
    if (!this.pending) this.pending = this.run();
    try {
      return structuredClone(await this.pending);
    } finally {
      this.pending = undefined;
    }
  }
  /** Run independent checks in parallel; redact errors and abort timed-out work. */
  private async run(): Promise<HealthReport> {
    const checks = await Promise.all(
      this.probes.map(async (probe) => {
        const start = performance.now(),
          controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined,
          status: "up" | "down" = "up";
        try {
          await Promise.race([
            Promise.resolve().then(() => probe.check(controller.signal)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("Timeout"));
              }, this.timeoutMs);
            }),
          ]);
        } catch {
          status = "down";
        } finally {
          clearTimeout(timer);
        }
        return {
          id: probe.id,
          required: probe.required !== false,
          status,
          durationMs: Math.round(performance.now() - start),
        };
      }),
    );
    this.snapshot = {
      ok: checks.every((check) => !check.required || check.status === "up"),
      at: new Date().toISOString(),
      checks,
    };
    this.expires = Date.now() + this.cacheMs;
    return this.snapshot;
  }
  /** Public liveness/readiness expose only availability; dependency detail is owner-only. */
  feature(): Feature {
    return {
      id: "health",
      migrations: [],
      admin: {
        id: "health",
        title: "Service health",
        resource: "health.read",
        path: "/health/report",
        component: "health",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        {
          method: "GET",
          path: "/health/live",
          resource: "health.live",
          access: "guest",
          handle: async () => ({ ok: true }),
        },
        {
          method: "GET",
          path: "/health/ready",
          resource: "health.ready",
          access: "guest",
          handle: async () => {
            if (!(await this.report()).ok)
              throw new HttpError(503, "Service unavailable");
            return { ok: true };
          },
        },
        {
          method: "GET",
          path: "/health/report",
          resource: "health.read",
          access: "owner",
          handle: () => this.report(),
        },
      ],
    };
  }
}

export * from "./monitor.js";
