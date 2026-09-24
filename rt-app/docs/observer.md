# Observer

Open Admin → Observer. Admin → Themes offers Paper, Graphite, Midnight and System. Theme and sidebar width are saved per browser. Midnight is the default for new browsers.

Observer records API requests (method, matched route template, status, duration), SPA/SSR page views and structured application logs. It does not record request bodies, query strings, headers, tokens or raw IPs. Page tracking sends only declared page names; unknown pages are grouped under `/other`. Browser Do Not Track disables page tracking. Counts are events, not unique visitors; public client events can be spoofed and are not suitable for billing.

## Console-style logging

```ts
const console = app.observer.console; // scoped logger; does not patch global console
await console.info('Import completed', { count: 42 });
await console.error('Import failed', { jobId: 'job-1' });
```

Await logging in Lambda so delivery finishes before the invocation is frozen. Third-party/global console calls remain ordinary stdout logs; use the scoped logger to route them through Observer. Known sensitive keys and common secret strings are redacted, but arbitrary prose cannot be reliably scrubbed: never log secrets. Error objects expose only their name.

## Output adapters

Each output implements `ObserverOutputHandler` with `id` and `write(event, signal)`. Each subscription accepts `enabled`, `levels`, `kinds`, `sources`, `categories`, a synchronous `filter(event)` predicate, and `maxPerMinute`.

```ts
import { Observer } from '@gsalgadotoledo/rt-app-observer';
import { ConsoleOutput } from '@gsalgadotoledo/rt-app-observer-console';
import { EmailOutput } from '@gsalgadotoledo/rt-app-observer-email';

const observer = new Observer([
  { handler: new ConsoleOutput(), levels: ['info', 'warn', 'error'] },
  { handler: new EmailOutput('verified@example.com', 'ops@example.com'),
    enabled: true, levels: ['error'], kinds: ['log', 'request'], maxPerMinute: 1 },
]);
await observer.console.error('Import failed', { jobId: 'job-1' });
```

`createApplication({ observerOutputs: [...] })` now replaces the complete output list. Supplying `[]` disables all recording/delivery. Omit the option for the defaults: storage, console, and configured external outputs. If overriding, include an `ObserverStore` output explicitly to keep dashboard analytics. This is a change from alpha.0, where the option appended external outputs.

Packages: `observer`, `observer-console`, `observer-email` (SES or local SMTP), `observer-cloudwatch`, `observer-sms` (SNS). All are under `rt-app/packages`.

## Optional environment configuration

Unset variables mean no external output. Never expose these settings to public frontend configuration.

```sh
# Email to the existing local mail viewer
OBSERVER_EMAIL_TRANSPORT=local OBSERVER_EMAIL_TO=dev@example.test npm run dev

# AWS SES: verified sender / permitted recipient
OBSERVER_EMAIL_FROM=verified@example.com OBSERVER_EMAIL_TO=ops@example.com npm run dev

# Optional dedicated, pre-created CloudWatch group AND stream
OBSERVER_LOG_GROUP=/app/observer OBSERVER_LOG_STREAM=events npm run dev

# Optional SNS destination (E.164)
OBSERVER_SMS_TO=+15555550123 npm run dev
```

Email environment defaults send only errors in `payment`, `payments`, `purchase`, or `purchases`; SMS sends all errors. Both send at most one per minute **per process / Lambda execution environment**. These are suppression limits, not durable/global spending caps; suppressed events are not replayed. CloudWatch exports all kinds up to 600 events/minute per instance. Lambda stdout already reaches its standard CloudWatch group; the explicit handler is for a separate destination and would duplicate events if sent to the same stream.

Grant SES `ses:SendEmail` for the verified sender, CloudWatch `logs:PutLogEvents` for the pre-created stream, and SNS `sns:Publish` for SMS using your cloud role. Current runtime SES permissions restrict the sender to `MAIL_FROM`; use that sender or update the policy. The runtime Terraform now provisions a dedicated seven-day Observer group/stream and restricted read/write IAM permissions (including the bootstrap permission boundary). Apply both bootstrap and runtime changes when upgrading an existing deployment. SMS remains disabled by default. AWS sandbox/verification requirements and messaging charges still apply. No external notifications are sent during local installation.

## Storage and delivery limits

Events use daily UTC partitions in the configured NoSQL store with seven-day TTL. DynamoDB TTL deletion is asynchronous; reports immediately exclude expired events. Local JSON removes expired observer rows on the next write. The dashboard reads at most 20 pages per selected day and explicitly labels truncated reports. Rankings and totals describe the loaded events. It shows the last 100 **loaded** events, not a guaranteed complete historical search.

The default output limit is 600 events/minute/instance, with at most 32 concurrent emissions. Health counters are instance-local and reset on restart; they are not a fleet-wide total. Failures/timeouts cannot fail application requests. Deliveries are awaited in parallel with a 1.5-second timeout, so a slow destination can add that latency. Delivery is best-effort, not exactly-once; there is no durable retry/outbox yet. For high traffic use batching/queues and an aggregated analytics store instead of per-event JSON rewrites or unbounded daily reads.

The public ingestion endpoint validates events and has a per-instance limiter. Use API Gateway/WAF limits for distributed protection. Admin report access uses the separate admin identity; app users cannot read the stream.

## Dedicated methods

```ts
await app.observer.countView('Home page', { url: '/home', apiUrl: '/v1', source: 'spa' });
await app.observer.log('Import started', { jobId });
await app.observer.info('Import completed', { count: 42 });
await app.observer.warn('Retrying', { attempt: 2 }); // warning() is an alias
await app.observer.error('Import failed', { jobId });
await app.observer.debug('Cache lookup', { hit: true });

const result = await app.observer.measure('users.lookup', () => users.find(id));
```

`measure` returns the operation's result, preserves thrown errors, and records elapsed time on both success and failure. Timing excludes output delivery. Operation timing is separate from API request counts. The dashboard groups timings by operation name and source and shows count, average, minimum, maximum and errors for the selected UTC day.

The API automatically uses `recordRequest({method, url, status, durationMs})`. Use it only when integrating an additional transport; manually recording the same API call would double-count it. Use route templates such as `/users/:id` rather than real identifiers. Global request averages are weighted across captured requests, not averages of route averages. Metrics retain the existing bounded-read / best-effort limitations.

Backend `countView` records through configured handlers: `apiUrl` is optional metadata, never a remote destination. URLs lose credentials, query strings, fragments and hostnames. Paths and messages must still contain no sensitive data.

For browser code, use the browser entry point; there `apiUrl` is the destination:

```ts
import { countView } from '@gsalgadotoledo/rt-app-observer/browser';
const recorded = await countView('Home page', {
  url: window.location.href, apiUrl: configuredApiUrl, source: 'spa'
});
```

The browser helper returns a boolean and honors Do Not Track. It only sends allowlisted page paths (`pages` option); other paths become `/other`. Existing automatic SPA/SSR tracking uses this helper—do not add a second call for the same view.


## Categories, correlation and search

```ts
await app.observer.error('Payment declined', {category: 'payments', orderId: 'order-42'});
await app.observer.withContext({sessionId: 'opaque-random-correlation-id'}, async () => {
  await app.observer.info('Checkout started', {category: 'purchases'});
});
```

Every API request gets a server-generated `requestId`, propagated across async calls without mixing concurrent requests. Sessions are optional opaque correlation IDs supplied by trusted server code, never cookies or access tokens. `write(level, message, context, data)` is available for fully structured calls. Category defaults to `app` (HTTP events use `http` or `payments`).

Admin → Observer → Logs searches by UTC day, level, category, request ID, session ID and text. The default includes info, warn and error. Reads are owner-only and paginated. Empty filtered pages can still have a Next cursor. Local JSON projects store logs in `observer.json` beside their application JSON file; the application database is untouched. Other NoSQL adapters use isolated `OBSERVER#` partitions. Old JSON logs remain in the former file; they are not migrated automatically.

AWS Logs search reads the configured CloudWatch group directly; analytics continue using the NoSQL metrics snapshot. Delivery/read delays or suppression can make those two views differ. CloudWatch log search needs `logs:FilterLogEvents`. Outputs use awaited best-effort delivery, not a durable queue or guaranteed alerts.

```ts
const outputs = [{
  handler: new EmailOutput('verified@example.com', 'ops@example.com'),
  levels: ['error'], categories: ['payments', 'purchases'],
  filter: event => event.data.retryable !== true,
  maxPerMinute: 1,
}];
```

Filters run in trusted JavaScript configuration, never as executable strings from the admin. Predicates receive sanitized copies. A throwing filter or failing output increments delivery health without failing the request. Filters and rate limits are independent per output. Filters must be fast and synchronous.

## Output catalog

| Package suffix | Class | Destination |
| --- | --- | --- |
| observer | ObserverStore | Dedicated local JSON / NoSQL analytics and search |
| observer-console | ConsoleOutput | Structured stdout |
| observer-cloudwatch | CloudWatchOutput / CloudWatchLogReader | AWS Logs export / admin search |
| observer-email | EmailOutput / LocalEmailOutput | SES / local mail viewer |
| observer-sms | SmsOutput | SNS SMS |
| observer-slack | SlackOutput | Slack incoming webhook |
| observer-datadog | DatadogOutput | Datadog HTTP logs intake |
| observer-sentry | SentryOutput | Sentry message events (no automatic stack capture) |
| observer-webhook | WebhookOutput | Custom HTTPS JSON receiver |

All packages have the `@gsalgadotoledo/rt-app-` prefix. Remote transports never run in tests. Environment-enabled remote outputs are disabled during explicit local development; local email goes only to the loopback mail viewer. Custom outputs passed in code are explicit overrides and can send remotely.

Set server-side variables to opt in: `OBSERVER_SLACK_WEBHOOK`, `OBSERVER_DATADOG_API_KEY` (optional `OBSERVER_DATADOG_SITE`), or `OBSERVER_SENTRY_DSN`. Leave them unset to disable. Configure generic webhooks in code. No real recipient is assumed: email requires `OBSERVER_EMAIL_TO`; production SES also requires the verified `OBSERVER_EMAIL_FROM`.

Provider contracts: [Slack webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/), [Datadog logs](https://docs.datadoghq.com/api/latest/logs/), [Sentry envelopes](https://develop.sentry.dev/sdk/data-model/envelopes/), [CloudWatch search](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html).
