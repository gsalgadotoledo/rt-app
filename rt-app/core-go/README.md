# RT-App Go core

A small typed provider library plus the Go port of the RT-App modules. The import package of the root is `rtcore`; the development module path is `rt.local/core-go`. That path is local-only, not a published registry identity. No reflection-based wiring, automatic discovery, inheritance, global registry or service lookup by strings. The only third-party dependency is the official `github.com/aws/aws-lambda-go`, used by `weblambda` alone.

## Packages

TypeScript is the reference implementation; these packages pass the same language-neutral contracts (`rt-app/spec/contracts`, see `rt-app/docs/polyglot.md`).

| Package | Purpose |
| --- | --- |
| `apperr` | `*HTTPError{Status, Message}` answered as `{"error": message}`; `Conflict()` is 409 |
| `nosql` | `Store` interface (`Get`, `Transact`, `List`) and `MemoryStore` (version guards, atomic transactions, code point order, 50-row pages, partition-bound cursors) |
| `featureflags` | flags with rollouts and subjects; `ParseDefinition`/`ParseVersion`/`ParseSubject` check loosely-typed JSON with JavaScript `typeof` rules |
| `health` | `GET /health/live` and `/health/ready` |
| `web` | `App` (an `http.Handler` with the framework's routing, access checks and JSON errors), `Serve`, `RunCLI` |
| `weblambda` | API Gateway v1/v2 events via `aws-lambda-go`; `LocalBridge` runs the Lambda function behind local HTTP |
| `conformance` | contract host (protocol v1) with explicit method tables; `cmd/contract-host` registers `nosql-memory` and `feature-flags` |

```sh
go test -race ./... && go vet ./...
npm run contracts -- --target go,go-lambda   # from the repository root
```

A complete application (server, Lambda, CLI) is in `rt-app/examples/flags-api/go`.

## Local installation

From a generated Go backend, the `go.mod` already contains:

```go
require rt.local/core-go v0.0.0
replace rt.local/core-go => ../../rt-app/core-go
```

For another app, use `go mod edit -require=rt.local/core-go@v0.0.0` and `go mod edit -replace=rt.local/core-go=/absolute/path/to/core-go`, then import it and run `go mod tidy`. A future public release needs a real repository module path and version tag. Libraries use `go get <real-module-path>@<version>`; `go install` is for command-line executables.

## Constructors and interfaces

```go
type Mailer interface { Send(string) error; Close() error }

// adapter.New can take any required parameters plus conventional ...Option.
// Capture them once at the application composition root.
mailer := rtcore.New(func() (Mailer, error) {
    return adapter.New(config, adapter.WithTimeout(timeout))
}, rtcore.WithClose(func(m Mailer) error { return m.Close() }))
```

Different implementations can share a constructor signature to make an import alias swap sufficient. If configuration differs, change the composition root too; an interface only guarantees the consumer's method contract. Resolve with `Get()` at startup for eager initialization and inject the returned interface into handlers. Or call `Get()` when first needed for lazy initialization. Normal constructors without providers remain valid for cheap, request-local objects.

Run the working example:

```sh
go run ./examples/hello
go test -race ./...
```

Switch the adapter import in that example from `english` to `spanish`; its consumer interface stays unchanged.

## Lifecycle and limits

- Each provider owns one value. Two applications must build two sets of providers. Singleton is not a distributed lock, payment idempotency mechanism, or guarantee that methods on the returned component are thread-safe.
- Concurrent `Get` calls initialize once; initialization errors and panics are cached. A factory cleans up its own partial failures. Create a new provider to retry; never silently retry side effects.
- `Close` waits for an in-flight constructor, closes a successfully constructed component once, and returns the same cleanup error on later calls. It does not initialize unused components. `Get` after close returns `ErrClosed`.
- Drain requests before closing resources, and close consumers before dependencies. Use normal `defer`/`errors.Join` at the composition root. The library does not track active users of returned objects.
- Factory dependencies must be acyclic. Go has no automatic per-goroutine cycle detection here: recursive/mutually cyclic factories can deadlock. Prefer explicit constructor injection and avoid hidden service-locator calls. Factories/cleanup callbacks must not call methods on the provider they are initializing/closing.
- No hot-swapping a live instance, implicit cross-process sharing, automatic retries or async worker management. The Go modules cover health and feature flags; users, auth and the admin console remain TypeScript-only.
