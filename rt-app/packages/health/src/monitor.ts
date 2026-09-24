import { HealthChecks, type HealthReport } from "./index.js";

export interface AvailabilityAlert {
  service: string;
  status: "up" | "down";
  at: string;
}

/** Run from an independent worker or scheduler: a stopped API cannot report its own outage. */
export class AvailabilityMonitor {
  private states = new Map<string, "up" | "down">();
  private pending?: Promise<HealthReport>;

  constructor(
    private checks: HealthChecks,
    private notify: (alert: AvailabilityAlert) => Promise<void>,
  ) {}

  /** Notify initial failures and subsequent transitions. Retry notification failures next run. */
  async poll(): Promise<HealthReport> {
    if (this.pending) return this.pending;
    this.pending = this.run();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async run(): Promise<HealthReport> {
    const report = await this.checks.report();
    for (const check of report.checks) {
      const previous = this.states.get(check.id);
      if (
        previous !== check.status &&
        (previous !== undefined || check.status === "down")
      ) {
        await this.notify({
          service: check.id,
          status: check.status,
          at: report.at,
        });
      }
      this.states.set(check.id, check.status);
    }
    return report;
  }
}

/** URLs are trusted configuration, never user-supplied; redirects are deliberately rejected. */
export function httpHealthProbe(
  id: string,
  url: string,
  transport: typeof fetch = fetch,
) {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new TypeError("Invalid health URL");
  return {
    id,
    async check(signal: AbortSignal) {
      const response = await transport(url, { signal, redirect: "error" });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Service unavailable");
    },
  };
}
