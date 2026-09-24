import {
  postOutput,
  type ObserverEvent,
  type ObserverOutputHandler,
} from "@gsalgadotoledo/rt-app-observer";

/** Incoming webhook owned by the operator; disabled until explicitly configured. */
export class SlackOutput implements ObserverOutputHandler {
  readonly id = "slack";
  constructor(
    private webhook: string,
    private transport: typeof fetch = fetch,
  ) {
    const url = new URL(webhook);
    if (
      url.protocol !== "https:" ||
      !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) ||
      !url.pathname.startsWith("/services/")
    )
      throw new Error("Invalid Slack incoming webhook");
  }

  async write(event: ObserverEvent, signal?: AbortSignal) {
    await postOutput(
      this.webhook,
      JSON.stringify({
        text: `[${event.level}] ${event.category ?? event.source}: ${event.message}\nRequest: ${event.requestId ?? event.id}`,
        mrkdwn: false,
      }),
      { "Content-Type": "application/json" },
      signal,
      this.transport,
    );
  }
}
