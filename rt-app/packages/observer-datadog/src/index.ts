import {
  postOutput,
  type ObserverEvent,
  type ObserverOutputHandler,
} from "@gsalgadotoledo/rt-app-observer";

/** Datadog HTTP logs intake; the key remains server-side. */
export class DatadogOutput implements ObserverOutputHandler {
  readonly id = "datadog";
  constructor(
    private apiKey: string,
    private site = "datadoghq.com",
    private service = "rt-app",
    private transport: typeof fetch = fetch,
  ) {
    if (
      !apiKey ||
      ![
        "datadoghq.com",
        "us3.datadoghq.com",
        "us5.datadoghq.com",
        "datadoghq.eu",
        "ap1.datadoghq.com",
        "ap2.datadoghq.com",
        "ddog-gov.com",
      ].includes(site)
    )
      throw new Error("Invalid Datadog key or site");
  }

  async write(event: ObserverEvent, signal?: AbortSignal) {
    await postOutput(
      `https://http-intake.logs.${this.site}/api/v2/logs`,
      JSON.stringify([
        {
          ...event,
          status: event.level,
          service: this.service,
          ddsource: "rt-app",
        },
      ]),
      { "Content-Type": "application/json", "DD-API-KEY": this.apiKey },
      signal,
      this.transport,
    );
  }
}
