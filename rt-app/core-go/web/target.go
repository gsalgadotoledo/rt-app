package web

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// Go's net/url rejects request targets with invalid percent-escapes ("/flags/%E0%A4%A") before
// a handler runs, while Node accepts them and the framework answers 400 "Invalid URL".
// To keep that behavior, adapters escape the stray "%" signs (as "%25") and remember the
// target as received; RawTarget returns it.

type rawTargetKey struct{}

// RawTarget returns the request target (path and query) as the client sent it.
func RawTarget(r *http.Request) string {
	if target, ok := r.Context().Value(rawTargetKey{}).(string); ok {
		return target
	}
	if conn, ok := r.Context().Value(connKey{}).(*targetConn); ok {
		if target, ok := conn.original(r.RequestURI); ok {
			return target
		}
	}
	if strings.HasPrefix(r.RequestURI, "/") {
		return r.RequestURI
	}
	target := r.URL.EscapedPath()
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		target += "?" + r.URL.RawQuery
	}
	return target
}

// NewRequest is http.NewRequestWithContext for a target as received on the wire
// ("/path?query"), including targets with invalid percent-escapes.
func NewRequest(ctx context.Context, method, target string, body io.Reader) (*http.Request, error) {
	escaped := EscapeTarget(target)
	if escaped != target {
		ctx = context.WithValue(ctx, rawTargetKey{}, target)
	}
	r, err := http.NewRequestWithContext(ctx, method, escaped, body)
	if err != nil {
		return nil, err
	}
	r.RequestURI = escaped
	return r, nil
}

// EscapeTarget replaces each "%" that does not start a valid escape with "%25".
func EscapeTarget(target string) string {
	if !strings.Contains(target, "%") {
		return target
	}
	var b strings.Builder
	for i := 0; i < len(target); i++ {
		if target[i] == '%' && (i+2 >= len(target) || !isHex(target[i+1]) || !isHex(target[i+2])) {
			b.WriteString("%25")
			continue
		}
		b.WriteByte(target[i])
	}
	return b.String()
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}
