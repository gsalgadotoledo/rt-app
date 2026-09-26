// Command flagsapi serves the health and feature-flags modules, the API that every RT-App
// backend language implements (rt-app/spec/contracts/feature-flags-api.contract.yaml).
//
//	go run . -mode=serve                          # local HTTP server on 127.0.0.1:$PORT
//	go run . -mode=lambda-local                   # the Lambda function behind a local HTTP bridge
//	go run . -mode=cli GET /health/live           # one request, in-process
//	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap .   # -mode=lambda on AWS
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	rtcore "rt.local/core-go"
	"rt.local/core-go/featureflags"
	"rt.local/core-go/health"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
	"rt.local/core-go/weblambda"
)

// Components is the composition root: one provider per component, each built lazily once.
// To swap an implementation, change one constructor here (for example a DynamoDB store in
// place of nosql.NewMemoryStore); consumers only see the nosql.Store interface.
type Components struct {
	Store *rtcore.Singleton[nosql.Store]
	Flags *rtcore.Singleton[*featureflags.FeatureFlags]
	App   *rtcore.Singleton[*web.App]
}

// Compose wires the components. localAdmin mounts owner endpoints for anyone who can reach
// the server: use it only on a developer machine.
func Compose(localAdmin bool) *Components {
	c := &Components{}
	c.Store = rtcore.New(func() (nosql.Store, error) {
		return nosql.NewMemoryStore(), nil
	})
	c.Flags = rtcore.New(func() (*featureflags.FeatureFlags, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		return featureflags.New(store), nil
	})
	c.App = rtcore.New(func() (*web.App, error) {
		flags, err := c.Flags.Get()
		if err != nil {
			return nil, err
		}
		var options []web.Option
		if localAdmin {
			options = append(options, web.WithLocalAdmin())
		}
		return web.New([]web.Feature{health.Feature(), flags.Feature()}, options...)
	})
	return c
}

// Close releases the components, consumers before their dependencies.
func (c *Components) Close() error {
	return errors.Join(c.App.Close(), c.Flags.Close(), c.Store.Close())
}

func main() {
	mode := flag.String("mode", "", "serve | lambda | lambda-local | cli (default: lambda on AWS Lambda, else serve)")
	flag.Parse()
	if *mode == "" {
		*mode = "serve"
		if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
			*mode = "lambda"
		}
	}
	os.Exit(run(*mode, flag.Args()))
}

func run(mode string, args []string) int {
	// Real Lambda deployments never get local admin access.
	components := Compose(mode != "lambda")
	defer func() {
		if err := components.Close(); err != nil {
			log.Print(err)
		}
	}()
	app, err := components.App.Get()
	if err != nil {
		log.Print(err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := web.StopWhenOrphaned(ctx) // exit with `go run` when a tool stops it
	defer cancel()
	addr := net.JoinHostPort("127.0.0.1", port())

	switch mode {
	case "serve":
		return serve(ctx, addr, app, "Flags API")
	case "lambda-local":
		return serve(ctx, addr, weblambda.LocalBridge(weblambda.Handler(app)), "Flags API (Lambda, local bridge)")
	case "lambda":
		weblambda.Start(app)
		return 0
	case "cli":
		return web.RunCLI(app, args, os.Stdout, os.Stderr)
	default:
		fmt.Fprintf(os.Stderr, "unknown -mode %q (serve | lambda | lambda-local | cli)\n", mode)
		return 2
	}
}

func serve(ctx context.Context, addr string, handler http.Handler, name string) int {
	log.Printf("%s: http://%s", name, addr)
	if err := web.Serve(ctx, addr, handler); err != nil {
		log.Print(err)
		return 1
	}
	return 0
}

func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "4010"
}
