# RT-App Go core

A small typed provider library. The import package is `rtcore`; the development module path is `rt.local/core-go`. That path is local-only, not a published registry identity. No third-party dependencies, reflection, automatic discovery, inheritance, global registry or service lookup by strings.

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
- No hot-swapping a live instance, implicit cross-process sharing, automatic retries, async worker management, or admin/auth/CRUD feature parity with the TypeScript framework.
