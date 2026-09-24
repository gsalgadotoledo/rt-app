import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  validateLogQuery,
  matchesLog,
  type LogQuery,
  type LogPage,
  type ObserverLogReader,
  type ObserverOutputHandler,
  type ObserverEvent,
} from "@gsalgadotoledo/rt-app-observer";
/** Group and stream must already exist, managed by infrastructure. */
export class CloudWatchOutput implements ObserverOutputHandler {
  readonly id = "cloudwatch";
  constructor(
    private group: string,
    private stream: string,
    private client = new CloudWatchLogsClient({ maxAttempts: 1 }),
  ) {
    if (!group || !stream)
      throw new Error("Observer CloudWatch requires a log group and stream");
  }
  async write(event: ObserverEvent, signal?: AbortSignal) {
    await this.client.send(
      new PutLogEventsCommand({
        logGroupName: this.group,
        logStreamName: this.stream,
        logEvents: [
          { timestamp: Date.parse(event.at), message: JSON.stringify(event) },
        ],
      }),
      { abortSignal: signal },
    );
  }
}

/** Reads only the configured observer group, one bounded CloudWatch page per request. */
export class CloudWatchLogReader implements ObserverLogReader {
  constructor(
    private group: string,
    private client = new CloudWatchLogsClient({ maxAttempts: 1 }),
  ) {}

  async search(query: LogQuery): Promise<LogPage> {
    validateLogQuery(query);
    const start = Date.parse(query.day + "T00:00:00Z");
    const terms = [
      query.level
        ? `$.level = ${JSON.stringify(query.level)}`
        : '($.level = "info" || $.level = "warn" || $.level = "error")',
    ];
    for (const field of ["category", "requestId", "sessionId"] as const)
      if (query[field])
        terms.push(`$.${field} = ${JSON.stringify(query[field])}`);
    const page = await this.client.send(
      new FilterLogEventsCommand({
        logGroupName: this.group,
        startTime: start,
        endTime: start + 86400000 - 1,
        filterPattern: "{ " + terms.join(" && ") + " }",
        limit: 100,
        nextToken: query.cursor,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    const events: ObserverEvent[] = [];
    for (const row of page.events ?? []) {
      try {
        const event = JSON.parse(row.message ?? "");
        if (
          typeof event.id === "string" &&
          typeof event.at === "string" &&
          typeof event.message === "string" &&
          event.data &&
          matchesLog(event, query)
        )
          events.push(event);
      } catch {
        /* Other producers may write non-Observer records. */
      }
    }
    return {
      events,
      cursor: page.nextToken === query.cursor ? undefined : page.nextToken,
    };
  }
}
