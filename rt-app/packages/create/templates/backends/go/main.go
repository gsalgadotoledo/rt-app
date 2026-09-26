// Command backend is the Go API of this RT-App project. main.go is the composition root: one
// provider per component; change one constructor to swap an implementation.
//
// Native routes (health, feature flags, greeting, your modules) answer here. Every other route
// (admin, auth, users, CRUD…) goes to the RT-App Node core (RT_APP_CORE_API_URL), so modules can
// move to Go one at a time; the RT-App contracts keep them equivalent to TypeScript.
//
//	go run . -mode=serve                 # HTTP on 127.0.0.1:$PORT (npm run dev does this)
//	go run . -mode=lambda-local          # the Lambda handler behind a local HTTP bridge
//	go run . -mode=cli GET /hello        # one request, in-process
//	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap .   # AWS Lambda
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
	"rt.local/core-go/nosql/postgres"
	"rt.local/core-go/web"
	"rt.local/core-go/weblambda"
	"rtapp/backend/greeting"
)

// Components is the composition root; each provider builds its component once, lazily.
type Components struct {
	Store    *rtcore.Singleton[nosql.Store]
	Flags    *rtcore.Singleton[*featureflags.FeatureFlags]
	Greeting *rtcore.Singleton[*greeting.Client]
	App      *rtcore.Singleton[*web.App]
}

// Compose wires the components. localAdmin lets owner endpoints under /admin/app act as the
// local owner: development machines only.
func Compose(ctx context.Context, localAdmin bool) *Components {
	c := &Components{}
	c.Store = rtcore.New(func() (nosql.Store, error) {
		// PostgreSQL with DATABASE_URL (the same rows as the Node core); memory otherwise.
		if url := os.Getenv("DATABASE_URL"); url != "" {
			return postgres.Connect(ctx, url, postgres.Options{})
		}
		return nosql.NewMemoryStore(), nil
	})
	c.Flags = rtcore.New(func() (*featureflags.FeatureFlags, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		return featureflags.New(store), nil
	})
	c.Greeting = rtcore.New(func() (*greeting.Client, error) { return greeting.New(greeting.WithName("Go")) })
	c.App = rtcore.New(func() (*web.App, error) {
		flags, err := c.Flags.Get()
		if err != nil {
			return nil, err
		}
		hello, err := c.Greeting.Get()
		if err != nil {
			return nil, err
		}
		var options []web.Option
		if localAdmin {
			options = append(options, web.WithLocalAdmin())
		}
		if core := os.Getenv("RT_APP_CORE_API_URL"); core != "" {
			proxy, err := web.NewCoreProxy(core)
			if err != nil {
				return nil, err
			}
			options = append(options, web.WithFallback(proxy))
		}
		return web.New([]web.Feature{health.Feature(), flags.Feature(), hello.Feature()}, options...)
	})
	return c
}

// Close releases the components, consumers before their dependencies.
func (c *Components) Close() error {
	return errors.Join(c.App.Close(), c.Greeting.Close(), c.Flags.Close(), c.Store.Close())
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := web.StopWhenOrphaned(ctx) // exit with `go run` when a tool stops it
	defer cancel()
	components := Compose(ctx, mode != "lambda" && os.Getenv("RT_APP_TARGET") != "aws")
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
	addr := net.JoinHostPort("127.0.0.1", port())
	switch mode {
	case "serve":
		return serve(ctx, addr, app, "Go API")
	case "lambda-local":
		return serve(ctx, addr, weblambda.LocalBridge(weblambda.Handler(app)), "Go API (Lambda, local bridge)")
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
