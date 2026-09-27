# Resume the Python/Go port (paused 2026-09-26)

## Branches

- **`feature/0.3.0-contracts`** holds everything finished and green: contracts plus Python and Go
  ports with tests. On that branch `npm run contracts:stores` passes on node, python and go (it
  was last run before the queue, migrations, microservices, observer and subscriptions ports were
  merged, so re-run it first), and `release:check` passed earlier on it.
- **`wip/polyglot-wave-4`** (this branch) is that branch plus unfinished work from 4 paused
  agents. It may not build or pass yet. Finish each module here, check it, then bring it to the
  feature branch.

## Ported and green (on the feature branch)

- **Storage:** nosql (memory, PostgreSQL, DynamoDB).
- **Identity and billing:** jwt, users, acl, auth; subscriptions ledger, credits and the full
  service (settings, accounts, usage, overview, api).
- **Application modules:** feature-flags, health, analytics, visits, idempotency, cache (memory,
  nosql, file, dynamodb), choice (+jev, transformers), content, tasks, queue, migrations,
  microservices.
- **Observer:** core plus the console, webhook, slack, email and sms outputs.

## In progress on this branch (paused mid-work)

| Module | State when paused | Next step |
| --- | --- | --- |
| mail-local, mail-smtp, json store | Contracts, TS changes, Python and Go ports written. The Go `mail` package did not compile (`encodeWord` undefined in normalize.go). The FileCache store was moving onto the new JSON store (cache files touched). | Fix the Go build. Write mail-local-api plus the example modules (started). Run the cache, nosql, json and mail contracts. |
| deploy, deployments | Contracts written: deploy, deploy-client, deployments, deployments-server, deployments-cli. TS changes in deployments/server.ts. `deploy.contract.yaml` had a YAML error at about line 203. No Python or Go port yet. | Fix the YAML, check against node, then port to Python and Go. |
| cache-redis, queue-sqs, queue-rabbitmq | cache-redis contract and cloud-queues.mjs host started. The SQS contract was next. No ports yet. | Finish the contracts, then the ports (fake clients, optional real libraries). |
| subscriptions-stripe | Stripe TS files touched. The sync-stats test was added (`packages/subscriptions/tests/sync-stats.test.mjs`) and the TS sync fix was in progress in `subscriptions/src/index.ts`. | Finish the sync fix (merge the two stats writes), then the stripe contracts and ports. |

The shared go.mod and go.sum were changed with `go get` by these agents. Run `go mod tidy` in
core-go and `examples/api/go` once everything builds.

## Still to do after that

- **Cloud outputs and identity:** observer-cloudwatch, -datadog, -sentry; auth-cognito; the aws
  and infra modules.
- **Deploy providers:** deploy-render, -railway, -flyio, -digitalocean, -heroku, -vercel, -neon,
  -supabase (fake HTTP clients).
- **Status section:** list every new contract in the Status section of `docs/polyglot.md`.
- **Final checks:** `npm run contracts:stores` on all targets, `release:check`, package and
  reinstall the Service Manager, push.

## Decision pending (ask the user)

The subscriptions 429 message names the first window that is fully used (day, then week, then
period), not the window that actually blocks the request. Should it name the blocking window?

## How to resume

1. `git checkout wip/polyglot-wave-4`
2. Relaunch one agent per in-progress module with the same instructions as before. Each agent
   gets: the module scope, READ FIRST docs and hosts, deliverables, the verification commands,
   and the rules on shared files. Tell each agent to start from the existing files.
3. As each module goes green, commit it; merge into `feature/0.3.0-contracts` at the end.
