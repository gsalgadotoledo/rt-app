# Idempotency and API health

The application exposes a persistent executor backed by its configured NoSQL adapter (JSON locally, DynamoDB remotely):

```ts
const result = await app.idempotency.execute({
  scope: `shop/${authenticatedTenantId}/orders/v1`,
  key: requestIdempotencyKey, // Keep this key on retries; a new purchase gets a new key.
  input: { productId, quantity },
}, async ({ input, idempotencyKey }) => {
  return payments.createOrder(input, { idempotencyKey });
});
```

Authorize and validate before executing. Include tenant/actor and operation version in the scope. Results must be JSON. Same key with different input fails with CONFLICT; concurrent execution fails with PENDING. Failed/ambiguous work becomes UNCERTAIN and requires reconciliation with the provider, never an automatic charge retry. Pass the supplied key to providers supporting idempotency. Claims intentionally have no TTL: automatic deletion could repeat a payment. This is duplicate suppression, not a transaction spanning external systems.

## API analytics and alerts

Observer → API lists captured requests, errors, average and maximum latency by route, ranked by volume. Existing framework instrumentation records canonical routes, not raw IDs or query strings.

```ts
import { ApiAlerts } from '@gsalgadotoledo/rt-app-observer';
const traffic = new ApiAlerts({
  requests: 1000, errors: 20, averageMs: 1500,
  minimumSamples: 20, windowMs: 60_000,
}, async alert => {
  await app.observer.error('API threshold exceeded', {
    category: 'availability', ...alert,
  });
});
// Add { handler: traffic, kinds: ['request'] } to observerOutputs.
// An explicit observerOutputs array replaces defaults; retain the desired storage/output handlers.
```

Windows are per-process, bounded and emit at most one successful notification each. Delivery remains best effort. Configure an email/Slack output for category `availability`; no messages are sent unless that destination is configured. Use centralized metrics/alarms for aggregate Lambda traffic. An alert does not stop requests or replace rate limiting.

## Availability from outside the API

```ts
import { HealthChecks, AvailabilityMonitor, httpHealthProbe } from '@gsalgadotoledo/rt-app-health';
const monitor = new AvailabilityMonitor(new HealthChecks([
  httpHealthProbe('public-api', 'https://YOUR_API/health/ready'),
], 2000, 0), async alert => {
  await observer.error('Service availability changed', {
    category: 'availability', ...alert,
  });
});
await monitor.poll(); // Call every minute from an independent worker/scheduler.
```

Initial failures, outages and recoveries notify once per transition in that worker. Failed notifications retry on the next poll. State is process-local: a new worker can notify an ongoing outage again. Configure trusted URLs in code. Probe response bodies are discarded. The existing Service health admin section shows dependency checks; a stopped API cannot serve its dashboard. No external scheduler or cloud alarm is provisioned by these helpers.
