import {
  postOutput,
  type ObserverEvent,
  type ObserverOutputHandler,
} from "@gsalgadotoledo/rt-app-observer";

/** Sends structured message events, without global SDK hooks or automatic PII collection. */
export class SentryOutput implements ObserverOutputHandler {
  readonly id = "sentry";
  private endpoint: string;
  constructor(
    private dsn: string,
    private transport: typeof fetch = fetch,
  ) {
    const url = new URL(dsn),
      segments = url.pathname.split("/").filter(Boolean),
      project = segments.pop();
    if (
      url.protocol !== "https:" ||
      !url.username ||
      url.password ||
      !project ||
      !/^\d+$/.test(project) ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Sentry DSN");
    this.endpoint = `${url.origin}/${segments.length ? segments.join("/") + "/" : ""}api/${project}/envelope/`;
  }

  async write(event: ObserverEvent, signal?: AbortSignal) {
    const id = event.id.replaceAll("-", "");
    const body =
      [
        { event_id: id, dsn: this.dsn, sent_at: new Date().toISOString() },
        { type: "event" },
        {
          event_id: id,
          timestamp: Date.parse(event.at) / 1000,
          platform: "node",
          level: event.level === "warn" ? "warning" : event.level,
          message: event.message,
          tags: {
            category: event.category ?? "app",
            source: event.source,
            requestId: event.requestId ?? "",
          },
          extra: event,
        },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n";
    await postOutput(
      this.endpoint,
      body,
      { "Content-Type": "application/x-sentry-envelope" },
      signal,
      this.transport,
    );
  }
}
