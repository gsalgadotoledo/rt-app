package web

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

// Serve listens on addr and serves handler until ctx is canceled, then shuts down gracefully.
// An address without a host (":4010") binds 127.0.0.1 only; name a host to listen elsewhere.
func Serve(ctx context.Context, addr string, handler http.Handler) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" {
		addr = net.JoinHostPort("127.0.0.1", port)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return ServeListener(ctx, ln, handler)
}

// ServeListener serves handler on ln until ctx is canceled. It closes ln.
func ServeListener(ctx context.Context, ln net.Listener, handler http.Handler) error {
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if tc, ok := c.(*targetConn); ok {
				return context.WithValue(ctx, connKey{}, tc)
			}
			return ctx
		},
	}
	stopped := make(chan error, 1)
	stop := context.AfterFunc(ctx, func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		stopped <- server.Shutdown(shutdown)
	})
	defer stop()
	err := server.Serve(targetListener{ln})
	if errors.Is(err, http.ErrServerClosed) {
		return <-stopped
	}
	return err
}

type connKey struct{}

// targetListener wraps connections so that request lines with invalid percent-escapes reach
// the handler (see RawTarget) instead of Go's plain-text "400 Bad Request".
type targetListener struct{ net.Listener }

func (l targetListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &targetConn{Conn: c, lineStart: true}, nil
}

// targetConn rewrites the request line that starts each request. A request starts with the
// first bytes of the connection and with the first bytes read after a response was written
// (clients that do not pipeline). The rewritten target is remembered for RawTarget.
type targetConn struct {
	net.Conn
	scratch []byte // net/http never reads one connection concurrently

	mu        sync.Mutex
	pending   []byte
	lineStart bool
	rewritten string
	received  string
}

func (c *targetConn) Read(p []byte) (int, error) {
	c.mu.Lock()
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		c.mu.Unlock()
		return n, nil
	}
	c.mu.Unlock()
	if c.scratch == nil {
		c.scratch = make([]byte, 8<<10)
	}
	n, err := c.Conn.Read(c.scratch)
	if n == 0 {
		return 0, err
	}
	data := c.scratch[:n]
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lineStart {
		c.lineStart = false
		data = c.rewriteRequestLine(data)
	}
	k := copy(p, data)
	if k < len(data) {
		c.pending = append([]byte(nil), data[k:]...)
		return k, nil
	}
	return k, err
}

func (c *targetConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.mu.Lock()
		c.lineStart = true
		c.mu.Unlock()
	}
	return n, err
}

// rewriteRequestLine escapes stray "%" in "METHOD TARGET HTTP/1.x". Caller holds c.mu.
func (c *targetConn) rewriteRequestLine(data []byte) []byte {
	end := bytes.IndexByte(data, '\n')
	if end < 0 {
		return data
	}
	line := bytes.TrimSuffix(data[:end], []byte("\r"))
	parts := bytes.Split(line, []byte(" "))
	if len(parts) != 3 || !bytes.HasPrefix(parts[2], []byte("HTTP/")) {
		return data
	}
	c.rewritten, c.received = "", ""
	target := string(parts[1])
	escaped := EscapeTarget(target)
	if escaped == target {
		return data
	}
	c.rewritten, c.received = escaped, target
	out := make([]byte, 0, len(data)+len(escaped)-len(target))
	out = append(out, parts[0]...)
	out = append(out, ' ')
	out = append(out, escaped...)
	out = append(out, ' ')
	out = append(out, data[len(parts[0])+1+len(target)+1:]...)
	return out
}

// original returns the target as received when requestURI is the rewritten one.
func (c *targetConn) original(requestURI string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.rewritten != "" && c.rewritten == requestURI {
		return c.received, true
	}
	return "", false
}
