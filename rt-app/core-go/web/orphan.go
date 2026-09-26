package web

import (
	"context"
	"os"
	"time"
)

// StopWhenOrphaned returns a context that is canceled when this process's parent exits.
//
// `go run` does not forward SIGTERM to the program it built, so a tool that stops a
// `go run` child (such as the contract runner) would leave the program running and holding
// its port and pipes. Servers started that way use this to exit with their parent.
func StopWhenOrphaned(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	parent := os.Getppid()
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if os.Getppid() != parent {
					cancel()
					return
				}
			}
		}
	}()
	return ctx, cancel
}
