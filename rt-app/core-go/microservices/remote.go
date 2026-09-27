package microservices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/web"
)

// ErrRemoteConfiguration is returned by RemoteFeature for an unsafe base URL or timeout.
var ErrRemoteConfiguration = errors.New("Invalid remote service configuration")

// parseURL accepts absolute URLs only (WHATWG "Invalid URL" otherwise); the scheme is
// lower-cased and an https URL needs a host.
func parseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return nil, ErrInvalidURL
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if (u.Scheme == "https" || u.Scheme == "http") && u.Host == "" {
		return nil, ErrInvalidURL
	}
	u.Host = strings.ToLower(u.Host)
	if u.Scheme == "https" {
		u.Host = strings.TrimSuffix(u.Host, ":443")
	}
	return u, nil
}

func hasPassword(user *url.Userinfo) bool {
	password, set := user.Password()
	return set && password != ""
}

type remoteConfig struct {
	transport http.RoundTripper
	timeout   time.Duration
}

// RemoteOption configures RemoteFeature.
type RemoteOption func(*remoteConfig)

// WithTransport sets the HTTP transport (default http.DefaultTransport).
func WithTransport(transport http.RoundTripper) RemoteOption {
	return func(c *remoteConfig) { c.transport = transport }
}

// WithTimeout sets the timeout of each forwarded request: whole milliseconds from 1 ms to
// 2147483647 ms (default 10 s).
func WithTimeout(timeout time.Duration) RemoteOption {
	return func(c *remoteConfig) { c.timeout = timeout }
}

type queryOrderKey struct{}

// WithQueryOrder records the order of the query parameters of the incoming request (Go maps
// have none), so forwarded query strings keep it like JavaScript objects do. Without it,
// integer-like keys come first in ascending order and the others are sorted.
func WithQueryOrder(ctx context.Context, keys []string) context.Context {
	return context.WithValue(ctx, queryOrderKey{}, keys)
}

var paramPattern = regexp.MustCompile(`:([A-Za-z0-9_]+)`)

// RemoteFeature replaces the handlers of f with HTTPS calls to baseURL, keeping every endpoint
// field (access, resource, tool metadata, subscription). Only the Authorization header is
// forwarded; redirects are errors; nothing is retried. A non-2xx answer becomes an
// *apperr.HTTPError with its status and "Remote service request failed" (the body is
// discarded); 204 answers nil, other answers their JSON body.
func RemoteFeature(f Feature, baseURL string, options ...RemoteOption) (Feature, error) {
	base, err := parseURL(baseURL)
	if err != nil {
		return Feature{}, err
	}
	config := remoteConfig{transport: http.DefaultTransport, timeout: 10 * time.Second}
	for _, option := range options {
		option(&config)
	}
	if base.Scheme != "https" || base.User != nil && (base.User.Username() != "" || hasPassword(base.User)) ||
		base.RawQuery != "" || base.Fragment != "" ||
		config.timeout%time.Millisecond != 0 || config.timeout < time.Millisecond || config.timeout > math.MaxInt32*time.Millisecond {
		return Feature{}, ErrRemoteConfiguration
	}
	client := &http.Client{
		Transport:     config.transport,
		Timeout:       config.timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") },
	}
	prefix := "https://" + base.Host + strings.TrimSuffix(base.EscapedPath(), "/")
	out := Feature{ID: f.ID, Endpoints: make([]Endpoint, len(f.Endpoints))}
	for i, e := range f.Endpoints {
		endpoint := e
		endpoint.Handle = func(c *web.Context) (any, error) { return forward(client, prefix, e.Endpoint, c) }
		out.Endpoints[i] = endpoint
	}
	return out, nil
}

func forward(client *http.Client, prefix string, e web.Endpoint, c *web.Context) (any, error) {
	var invalid bool
	path := paramPattern.ReplaceAllStringFunc(e.Path, func(match string) string {
		value, ok := c.Params[match[1:]]
		if !ok {
			return "undefined"
		}
		if value == "." || value == ".." {
			invalid = true
		}
		return js.EncodeURIComponent(value)
	})
	if invalid {
		return nil, apperr.BadRequest("Invalid route parameter")
	}
	target := prefix + path
	if query := formEncode(c.Request.Query, queryOrder(c)); query != "" {
		target += "?" + query
	}
	var body io.Reader
	if e.Method != http.MethodGet && e.Method != http.MethodHead {
		text, present, err := stringify(c.Request)
		if err != nil {
			return nil, err
		}
		if present {
			body = strings.NewReader(text)
		}
	}
	ctx := context.Background()
	if c.Ctx != nil {
		ctx = c.Ctx
	}
	req, err := http.NewRequestWithContext(ctx, e.Method, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if authorization := c.Request.Headers.Get("Authorization"); authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := client.Do(req)
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return nil, urlErr.Err
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, apperr.New(resp.StatusCode, "Remote service request failed")
	}
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func queryOrder(c *web.Context) []string {
	if c.Ctx != nil {
		if keys, ok := c.Ctx.Value(queryOrderKey{}).([]string); ok {
			return keys
		}
	}
	return nil
}

// formEncode is URLSearchParams.toString(): application/x-www-form-urlencoded with only
// *-._ and ASCII alphanumerics unescaped and spaces as "+".
func formEncode(query map[string]string, order []string) string {
	keys := make([]string, 0, len(query))
	seen := map[string]bool{}
	for _, k := range order {
		if _, ok := query[k]; ok && !seen[k] {
			keys, seen[k] = append(keys, k), true
		}
	}
	var rest []string
	for k := range query {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	keys = append(keys, jsKeyOrder(rest)...)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = formComponent(k) + "=" + formComponent(query[k])
	}
	return strings.Join(parts, "&")
}

func formComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ':
			b.WriteByte('+')
		case 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '*' || c == '-' || c == '.' || c == '_':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte("0123456789ABCDEF"[c>>4])
			b.WriteByte("0123456789ABCDEF"[c&15])
		}
	}
	return b.String()
}

// arrayIndex reports a JavaScript array-index property name ("0", "42", not "01").
func arrayIndex(k string) (uint64, bool) {
	n, err := strconv.ParseUint(k, 10, 32)
	return n, err == nil && n < math.MaxUint32 && strconv.FormatUint(n, 10) == k
}

// jsKeyOrder sorts keys without a known order: array indices ascending, then the others.
func jsKeyOrder(keys []string) []string {
	slices.SortFunc(keys, func(a, b string) int {
		ai, aok := arrayIndex(a)
		bi, bok := arrayIndex(b)
		switch {
		case aok && bok:
			return int(ai) - int(bi)
		case aok:
			return -1
		case bok:
			return 1
		}
		return canonical.Less(a, b)
	})
	return keys
}

// stringify is JSON.stringify(request.body): the raw body keeps its key order (as
// JSON.parse would); without it, Body is written with sorted keys. present is false when there
// is no body at all (JavaScript undefined).
func stringify(r web.Request) (string, bool, error) {
	if len(bytes.TrimSpace(r.Raw)) > 0 {
		dec := json.NewDecoder(bytes.NewReader(r.Raw))
		dec.UseNumber()
		node, err := readOrdered(dec)
		if err == nil {
			var b strings.Builder
			writeOrdered(&b, node)
			return b.String(), true, nil
		}
	}
	if r.Body == nil {
		return "", false, nil
	}
	text, err := canonical.Marshal(r.Body, func(canonical.Kind) error { return errors.New("body is not JSON") })
	return text, err == nil, err
}

type orderedObject struct {
	keys   []string
	values map[string]any
}

func readOrdered(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := token.(type) {
	case json.Delim:
		if t == '[' {
			list := []any{}
			for dec.More() {
				item, err := readOrdered(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, item)
			}
			_, err := dec.Token()
			return list, err
		}
		object := &orderedObject{values: map[string]any{}}
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key := keyToken.(string)
			value, err := readOrdered(dec)
			if err != nil {
				return nil, err
			}
			if _, dup := object.values[key]; !dup {
				object.keys = append(object.keys, key)
			}
			object.values[key] = value
		}
		_, err := dec.Token()
		return object, err
	default:
		return token, nil
	}
}

func writeOrdered(b *strings.Builder, v any) {
	switch x := v.(type) {
	case *orderedObject:
		// JavaScript objects list array-index keys first, in ascending order.
		var indices, names []string
		for _, k := range x.keys {
			if _, ok := arrayIndex(k); ok {
				indices = append(indices, k)
			} else {
				names = append(names, k)
			}
		}
		b.WriteByte('{')
		for i, k := range append(jsKeyOrder(indices), names...) {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(canonical.Quote(k))
			b.WriteByte(':')
			writeOrdered(b, x.values[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeOrdered(b, item)
		}
		b.WriteByte(']')
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64)
		if math.IsInf(f, 0) {
			b.WriteString("null")
		} else {
			b.WriteString(js.FormatNumber(f))
		}
	case string:
		b.WriteString(canonical.Quote(x))
	case bool:
		b.WriteString(strconv.FormatBool(x))
	default:
		b.WriteString("null")
	}
}
