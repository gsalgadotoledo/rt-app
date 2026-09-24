import type { ObserverEvent, ObserverOutputHandler } from "./index.js";

export interface ApiAlert {
  requests: number;
  errors: number;
  averageMs: number;
  windowMs: number;
  reasons: string[];
}
export interface ApiAlertOptions {
  windowMs?: number;
  requests?: number;
  errors?: number;
  averageMs?: number;
  minimumSamples?: number;
}

/** Bounded, instance-local windows. Distributed fleet alarms belong in a shared metrics backend. */
export class ApiAlerts implements ObserverOutputHandler {
  readonly id = "api-alerts";
  private started: number;
  private count = 0;
  private errors = 0;
  private duration = 0;
  private sent = false;
  private sending = false;
  private readonly options: Required<ApiAlertOptions>;

  constructor(
    options: ApiAlertOptions,
    private notify: (alert: ApiAlert) => Promise<void>,
    private clock = Date.now,
  ) {
    this.options = {
      windowMs: 60000,
      requests: Infinity,
      errors: Infinity,
      averageMs: Infinity,
      minimumSamples: 10,
      ...options,
    };
    for (const value of Object.values(this.options))
      if (!(value > 0)) throw new TypeError("Invalid API alert threshold");
    if (
      !Number.isFinite(this.options.windowMs) ||
      !Number.isFinite(this.options.minimumSamples)
    )
      throw new TypeError("Invalid API alert window");
    this.started = clock();
  }

  /** At most one successful notification per window; failed sends can retry on later requests. */
  async write(event: Readonly<ObserverEvent>): Promise<void> {
    if (event.kind !== "request") return;
    const { status, durationMs } = event.data;
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;
    const now = this.clock();
    if (now - this.started >= this.options.windowMs && !this.sending) {
      this.started = now;
      this.count = 0;
      this.errors = 0;
      this.duration = 0;
      this.sent = false;
    }
    this.count++;
    this.errors += status >= 500 ? 1 : 0;
    this.duration += durationMs;
    if (this.sent || this.sending) return;
    const averageMs = this.duration / this.count;
    const reasons = [
      ...(this.count >= this.options.requests ? ["request-volume"] : []),
      ...(this.errors >= this.options.errors ? ["server-errors"] : []),
      ...(this.count >= this.options.minimumSamples &&
      averageMs >= this.options.averageMs
        ? ["latency"]
        : []),
    ];
    if (!reasons.length) return;
    this.sending = true;
    try {
      await this.notify({
        requests: this.count,
        errors: this.errors,
        averageMs,
        windowMs: this.options.windowMs,
        reasons,
      });
      this.sent = true;
    } finally {
      this.sending = false;
    }
  }
}
