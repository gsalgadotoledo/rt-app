package web

import (
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// CoreTimeout bounds how long NewCoreProxy waits for the upstream to connect and answer.
const CoreTimeout = 15 * time.Second

// CoreUnavailable is the message of the 502 answered when the upstream cannot be reached.
const CoreUnavailable = "RT-App core is unavailable"

// NewCoreProxy returns a reverse proxy to a loopback HTTP upstream such as the Node RT-App
// core ("http://127.0.0.1:4000"). Use it with WithFallback so a native API forwards the
// routes it does not implement yet:
//
//	core, err := web.NewCoreProxy(os.Getenv("RT_APP_CORE_API_URL"))
//	app, err := web.New(features, web.WithFallback(core))
//
// The request target is forwarded as received (invalid percent-escapes included, leading
// slashes collapsed so it can never name another host). Hop-by-hop headers are stripped in
// both directions and X-Forwarded-For/-Host/-Proto are set from this hop only (values sent
// by the client are dropped). Connecting and waiting for response headers are bounded by
// CoreTimeout; any upstream failure answers 502 {"error":"RT-App core is unavailable"}.
func NewCoreProxy(upstream string) (http.Handler, error) {
	target, err := url.Parse(upstream)
	if err != nil || target.Scheme != "http" || target.Port() == "" || !isLoopback(target.Hostname()) ||
		target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return nil, errors.New("web: the core must be a loopback HTTP URL such as http://127.0.0.1:4000")
	}
	base := strings.TrimSuffix(target.EscapedPath(), "/")
	transport := &http.Transport{
		Proxy:                 nil, // never route loopback traffic through HTTP_PROXY
		DialContext:           (&net.Dialer{Timeout: CoreTimeout}).DialContext,
		ResponseHeaderTimeout: CoreTimeout,
		MaxIdleConnsPerHost:   32,
		IdleConnTimeout:       90 * time.Second,
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			raw := RawTarget(pr.In)
			path, query, _ := strings.Cut(raw, "?")
			path = "/" + strings.TrimLeft(path, "/")
			pr.Out.URL = &url.URL{Scheme: target.Scheme, Host: target.Host, Opaque: base + path, RawQuery: query}
			pr.Out.Host = target.Host
			pr.SetXForwarded()
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			writeJSON(w, http.StatusBadGateway, errorBody(CoreUnavailable))
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ReverseProxy keeps "TE: trailers" and protocol upgrades on purpose; the core needs
		// neither, so every hop-by-hop header stops here.
		if r.Header.Get("Te") != "" || r.Header.Get("Upgrade") != "" {
			r = r.Clone(r.Context())
			r.Header.Del("Te")
			r.Header.Del("Upgrade")
		}
		proxy.ServeHTTP(w, r)
	}), nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
