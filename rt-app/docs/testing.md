# Component verification

```sh
npm run build
npm run test:coverage
```

The command runs every workspace's existing test script, collects V8 coverage with c8, and checks both aggregate thresholds and per-component baselines. Tests remain in each owning package. `coverage/index.html` is the navigable report; `coverage/coverage-summary.json` and `coverage/components.json` are machine-readable. Reports and raw traces are ignored by Git.

## Scope and interpretation

The measured scope is executable JavaScript built from the backend packages, admin authentication, installer, framework composition and TypeScript module registry. `--all` includes files that no test imports. Two type-only modules are excluded because they emit no behavior (`core-ts/types`, `auth/provider`). Service-manager's Vite UI bundle is excluded: counting bundled React/vendor code would be misleading.

Existing workspace tests contain both isolated unit tests and offline integration tests. The reported percentage is their combined backend coverage, **not a pure unit-only percentage**. Browser/admin TSX, handwritten CLI/config/service-manager scripts, native Rust and Go/Python reference implementations are not represented by this percentage. Their existing tests still run where included in the workspace test scripts; native/language suites have their own commands below. Real provider compatibility and UI journeys require separate integration/E2E verification.

Global minimum: 90% lines/statements, 80% branches/functions. New backend components: 90% lines/statements, 80% branches, 85% functions. The checked-in component baseline records remaining older gaps, so a strong package cannot hide a regression in a weaker one. Existing components cannot fall below their recorded floors. Baselines must only rise after a successful full run; new exceptions require an explicit explanation and review. Do not exclude executable files merely to improve the percentage.

Initial strengthened run: 39 measured backend components; 96.59% lines, 85.76% branches and 93.30% functions. Every measured component exceeds 90% lines. Remaining targets are explicit: auth (branches/functions), Cognito (branches), AWS (branches/functions), framework (functions), Observer (functions), subscriptions (branches), installer (branches). Their floors preserve current behavior coverage while those additional paths are added; this is not a claim of exhaustive coverage or completed frontend E2E.

## What to test

| Component | Required cases |
| --- | --- |
| Storage/cache | Missing values, clone isolation, TTL boundaries, pagination, atomic conflict, concurrent writes, backend unavailable |
| Auth/ACL | Anonymous, owner, explicit grants, expired/malformed tokens, cross-user access, revocation, soft-deleted users |
| Payments/subscriptions | Minor-unit amounts, currencies, ownership before writes, idempotency, uncertain provider results, webhook signatures, reset boundaries |
| Observer/notifications | Filtering, redaction, bounded delivery, timeout/abort, partial failures, no credential leakage |
| Flags/visits/health | Stable evaluation, private rules, retention limits, forged inputs, opt-outs, dependency failure, cached results |

Use injected fakes for provider calls. Assert the command/payload and business result, plus that rejected operations caused **no** external write. Never send real email, Slack, WhatsApp, SMS, charges or AWS mutations in unit tests. Use temporary directories and clean them in test teardown. Prefer fake clocks to long sleeps. Service-manager tests run serially because they launch native processes and bind local ports.

## Other suites

```sh
npm run test:native -w @gsalgadotoledo/rt-app-service-manager
(cd rt-app/core-go && go test -race -cover ./...)
(cd rt-app/core-python && PYTHONPATH=src python3 -m unittest discover -s tests -v)
```

These require their respective toolchains. Passing backend coverage does not imply these suites ran. E2E for admin, SPA and SSR remains a separate browser-testing task.
