package health

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// Errors of HTTPProbe: the URL does not parse as an absolute URL, or it is not an http(s) URL
// without credentials.
var (
	ErrInvalidURL       = errors.New("Invalid URL")
	ErrInvalidHealthURL = errors.New("Invalid health URL")
)

// specialSchemes need a host (WHATWG URL "special" schemes other than file).
var specialSchemes = map[string]bool{"ftp": true, "http": true, "https": true, "ws": true, "wss": true}

// parseAbsolute is new URL(raw) for the URLs health probes accept.
func parseAbsolute(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || (specialSchemes[u.Scheme] && u.Hostname() == "") {
		return nil, ErrInvalidURL
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n > 65535 {
			return nil, ErrInvalidURL
		}
	}
	return u, nil
}

// HTTPProbe returns a probe that GETs rawURL and is up on 2xx. URLs are trusted configuration,
// never user input: only http(s) without user name or password is accepted, and redirects are
// not followed (a 3xx answer is down). client is used for the request (nil: a default client);
// the probe timeout comes from the context.
func HTTPProbe(id, rawURL string, client *http.Client) (Probe, error) {
	u, err := parseAbsolute(rawURL)
	if err != nil {
		return Probe{}, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return Probe{}, ErrInvalidHealthURL
	}
	if u.User != nil {
		password, _ := u.User.Password()
		if u.User.Username() != "" || password != "" {
			return Probe{}, ErrInvalidHealthURL
		}
	}
	noRedirects := http.Client{}
	if client != nil {
		noRedirects = *client
	}
	noRedirects.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return Probe{ID: id, Check: func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			return err
		}
		resp, err := noRedirects.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return errors.New("Service unavailable")
		}
		return nil
	}}, nil
}
