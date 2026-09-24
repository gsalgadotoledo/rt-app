import {
  postOutput,
  type ObserverEvent,
  type ObserverOutputHandler,
} from "@gsalgadotoledo/rt-app-observer";

/** Generic JSON sink, configured only by trusted server code. */
export class WebhookOutput implements ObserverOutputHandler {
  constructor(
    readonly id: string,
    private url: string,
    private headers: Record<string, string> = {},
    private transport: typeof fetch = fetch,
  ) {
    if (new URL(url).protocol !== "https:")
      throw new Error("Webhook output requires HTTPS");
  }

  async write(event: ObserverEvent, signal?: AbortSignal) {
    await postOutput(
      this.url,
      JSON.stringify(event),
      { "Content-Type": "application/json", ...this.headers },
      signal,
      this.transport,
    );
  }
}
