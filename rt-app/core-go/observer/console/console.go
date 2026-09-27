// Package console is the Observer output that writes one JSON line per event, like the
// TypeScript ConsoleOutput: console[level](JSON.stringify(event)).
package console

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"

	"rt.local/core-go/observer"
)

// Sink receives each line with the event level.
type Sink func(level, line string)

// Stdio writes debug and info lines to stdout and warn and error lines to stderr (Node's
// console streams).
func Stdio() Sink { return Writers(os.Stdout, os.Stderr) }

// Writers writes debug and info lines to out and warn and error lines to errs.
func Writers(out, errs io.Writer) Sink {
	var mu sync.Mutex
	return func(level, line string) {
		mu.Lock()
		defer mu.Unlock()
		w := out
		if level == "warn" || level == "error" {
			w = errs
		}
		fmt.Fprintln(w, line)
	}
}

// Output is the "console" output.
type Output struct {
	sink Sink
}

// New returns the console output; a nil sink is Stdio().
func New(sink Sink) *Output {
	if sink == nil {
		sink = Stdio()
	}
	return &Output{sink: sink}
}

// ID is "console".
func (o *Output) ID() string { return "console" }

// Write writes event.JSON(0) with its level.
func (o *Output) Write(_ context.Context, event observer.Event) error {
	o.sink(event.Level, event.JSON(0))
	return nil
}
