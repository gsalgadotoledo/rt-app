// Command contract-host serves the Go implementations for the language-neutral contracts
// (host protocol v1). Run it through the conformance runner:
//
//	npm run contracts -- --target go
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"rt.local/core-go/conformance"
	"rt.local/core-go/web"
)

// subjects is filled by register calls in the init functions of this package's files
// (storage.go, …): add a file per group of subjects.
var subjects = map[string]conformance.Subject{}

// register adds a subject; names are unique across files.
func register(name string, subject conformance.Subject) {
	if _, dup := subjects[name]; dup {
		panic("duplicate contract subject " + name)
	}
	subjects[name] = subject
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := web.StopWhenOrphaned(ctx) // the runner stops `go run`, not this program
	defer cancel()
	host := conformance.NewHost("go", subjects)
	if err := conformance.Run(ctx, host, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
