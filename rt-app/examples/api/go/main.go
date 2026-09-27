// Command api serves every native module (one file per module registers itself), the API that every RT-App
// backend language implements (rt-app/spec/contracts/feature-flags-api.contract.yaml).
//
//	go run . -mode=serve                          # local HTTP server on 127.0.0.1:$PORT
//	go run . -mode=lambda-local                   # the Lambda function behind a local HTTP bridge
//	go run . -mode=cli GET /health/live           # one request, in-process
//	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap .   # -mode=lambda on AWS
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	rtcore "rt.local/core-go"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
	"rt.local/core-go/weblambda"
)

// Components are the shared singletons modules build on. Swap the store here (PostgreSQL,
// DynamoDB…); modules only see the nosql.Store interface.
type Components struct {
	Store *rtcore.Singleton[nosql.Store]
	// Authenticator resolves the actor of endpoints outside /admin/ (set by the auth module;
	// without it every authenticated endpoint answers 401).
	Authenticator web.Authenticator
}

// Module builds the HTTP features of one module from the shared components. Each module file
// (health.go, featureflags.go, …) registers one in its init function.
type Module func(*Components) ([]web.Feature, error)

var modules []Module

func register(module Module) { modules = append(modules, module) }

// Compose builds the app from every registered module. localAdmin lets owner endpoints under
// /admin/app act as the local owner: use it only on a developer machine.
func Compose(localAdmin bool) (*web.App, *Components, error) {
	c := &Components{Store: rtcore.New(func() (nosql.Store, error) { return nosql.NewMemoryStore(), nil })}
	var features []web.Feature
	for _, module := range modules {
		f, err := module(c)
		if err != nil {
			return nil, c, err
		}
		features = append(features, f...)
	}
	var options []web.Option
	if c.Authenticator != nil {
		options = append(options, web.WithAuthenticator(c.Authenticator))
	}
	if localAdmin {
		options = append(options, web.WithLocalAdmin())
	}
	app, err := web.New(features, options...)
	return app, c, err
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
	app, components, err := Compose(mode != "lambda")
	defer func() {
		if err := components.Store.Close(); err != nil {
			log.Print(err)
		}
	}()
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
		return serve(ctx, addr, app, "Example API")
	case "lambda-local":
		return serve(ctx, addr, weblambda.LocalBridge(weblambda.Handler(app)), "Example API (Lambda, local bridge)")
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
