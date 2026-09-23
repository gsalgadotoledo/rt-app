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

Each output implements `ObserverOutputHandler` with `id` and `write(event, signal)`. Each subscription accepts `enabled`, `levels`, `kinds`, `sources`, and `maxPerMinute`.

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

`createApplication({ observerOutputs: [...] })` adds configured handlers to built-in storage and console. Supplying an empty array disables environment-configured external outputs. Standalone `Observer` controls the complete array.

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

Email and SMS environment defaults send errors only, at most one per minute **per process / Lambda execution environment**. These are suppression limits, not durable/global spending caps; suppressed events are not replayed. CloudWatch exports all kinds up to 600 events/minute per instance. Lambda stdout already reaches its standard CloudWatch group; the explicit handler is for a separate destination and would duplicate events if sent to the same stream.

Grant SES `ses:SendEmail` for the verified sender, CloudWatch `logs:PutLogEvents` for the pre-created stream, and SNS `sns:Publish` for SMS using your cloud role. Current runtime SES permissions restrict the sender to `MAIL_FROM`; use that sender or update the policy. The default deployment does not enable SMS permissions or provision an extra observer log stream. AWS sandbox/verification requirements and messaging charges still apply. No external notifications are sent during local installation.

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
