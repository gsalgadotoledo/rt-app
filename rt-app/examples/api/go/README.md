# Example API (Go)

The health and feature-flags modules served by the Go core (`rt-app/core-go`), in local admin
mode: owner endpoints are mounted under `/admin/app` and act as `rt-app-root`. `main.go` is the
composition root: one `rtcore.New(...)` provider per component. Swap the store by changing the
`nosql.NewMemoryStore()` line.

Accounts and sign-in (`auth.go`): `POST /admin/app/users` creates users, `POST /auth/login`
returns a 15-minute access token plus a rotating refresh token (`POST /auth/refresh`),
`GET/DELETE /auth/sessions` lists and revokes sessions and `POST /auth/logout` ends the current
session (`{"all": true}` ends every one). Set `RT_APP_SECRET` (32+ characters) so tokens survive
restarts and work across instances; codes go to a local mailbox.

```sh
# HTTP server on 127.0.0.1:$PORT (default 4010)
PORT=4010 go run . -mode=serve
curl -s localhost:4010/health/live

# The Lambda function behind a local HTTP bridge (API Gateway v2 events, in-process)
PORT=4011 go run . -mode=lambda-local

# One request from the command line; exit code 1 for statuses >= 400
go run . -mode=cli PUT /admin/app/feature-flags/checkout \
  --body '{"version":null,"description":"","enabled":true,"public":true,"rollout":100,"subjects":[]}'
go run . -mode=cli POST /feature-flags/evaluate --body '{"keys":["checkout"]}'
```

AWS Lambda (`provided.al2023`, API Gateway HTTP or REST API). Local admin is off in this mode,
so owner endpoints answer 401:

```sh
GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap . && zip function.zip bootstrap
```

Without `-mode`, the program runs as a Lambda function when `AWS_LAMBDA_RUNTIME_API` is set.

The memory store is per process, so state is lost on restart and not shared between Lambda
instances. Contract tests: `npm run contracts -- --target go,go-lambda` from the repository root.
