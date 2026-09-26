package web

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
)

const cliUsage = "usage: METHOD PATH [--body JSON] [--header name:value]..."

// RunCLI sends one request to handler in-process and prints the JSON response body.
//
//	RunCLI(app, []string{"POST", "/feature-flags/evaluate", "--body", `{"keys":["a"]}`}, os.Stdout, os.Stderr)
//
// It returns the process exit code: 0 for statuses below 400, 1 otherwise, 2 for bad usage.
func RunCLI(handler http.Handler, args []string, stdout, stderr io.Writer) int {
	var positional []string
	var body string
	headers := http.Header{}
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; arg {
		case "--body", "--header":
			if i+1 >= len(args) {
				fmt.Fprintf(stderr, "%s needs a value\n%s\n", arg, cliUsage)
				return 2
			}
			i++
			if arg == "--body" {
				body = args[i]
				continue
			}
			name, value, ok := strings.Cut(args[i], ":")
			if !ok || strings.TrimSpace(name) == "" {
				fmt.Fprintf(stderr, "invalid header %q\n%s\n", args[i], cliUsage)
				return 2
			}
			headers.Add(strings.TrimSpace(name), strings.TrimSpace(value))
		default:
			positional = append(positional, arg)
		}
	}
	if len(positional) != 2 || !strings.HasPrefix(positional[1], "/") {
		fmt.Fprintln(stderr, cliUsage)
		return 2
	}
	r, err := NewRequest(context.Background(), strings.ToUpper(positional[0]), positional[1], strings.NewReader(body))
	if err != nil {
		fmt.Fprintf(stderr, "%v\n%s\n", err, cliUsage)
		return 2
	}
	for name, values := range headers {
		r.Header[name] = values
	}
	if body != "" && r.Header.Get("Content-Type") == "" {
		r.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)
	fmt.Fprintln(stdout, strings.TrimRight(recorder.Body.String(), "\n"))
	if recorder.Code >= 400 {
		return 1
	}
	return 0
}
