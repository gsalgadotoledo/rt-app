package observer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"rt.local/core-go/observer/internal/whatwg"
)

// OutputRequest is one delivery to an HTTP destination.
type OutputRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// Transport sends one request and returns its status. It must not follow redirects.
type Transport func(ctx context.Context, request OutputRequest) (int, error)

// ErrCredentials is returned for destinations that are not HTTPS or carry URL credentials.
var ErrCredentials = errors.New("Observer destinations require HTTPS without URL credentials")

// HTTPTransport sends with client (nil: a client with a 10 s timeout); redirects are never
// followed and response bodies are discarded.
func HTTPTransport(client *http.Client) Transport {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	noRedirects := *client
	noRedirects.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return func(ctx context.Context, r OutputRequest) (int, error) {
		request, err := http.NewRequestWithContext(ctx, r.Method, r.URL, strings.NewReader(r.Body))
		if err != nil {
			return 0, err
		}
		for key, value := range r.Headers {
			request.Header.Set(key, value)
		}
		response, err := noRedirects.Do(request)
		if err != nil {
			return 0, err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		_ = response.Body.Close()
		return response.StatusCode, nil
	}
}

// ParseURL is new URL(raw) (WHATWG): the error is ErrInvalidURL.
func ParseURL(raw string) (*whatwg.URL, error) { return whatwg.Parse(raw, nil) }

// PostOutput POSTs body to an HTTPS destination without URL credentials (serialized like
// url.href); a status outside 200-299 is an error naming the status only. transport nil uses
// HTTPTransport(nil).
func PostOutput(ctx context.Context, url, body string, headers map[string]string, transport Transport) error {
	destination, err := whatwg.Parse(url, nil)
	if err != nil {
		return err
	}
	if destination.Scheme != "https" || destination.Username != "" || destination.Password != "" {
		return ErrCredentials
	}
	if transport == nil {
		transport = HTTPTransport(nil)
	}
	status, err := transport(ctx, OutputRequest{URL: destination.Href(), Method: http.MethodPost, Headers: headers, Body: body})
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("Observer destination returned HTTP %d", status)
	}
	return nil
}
