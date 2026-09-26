package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/apperr"
)

// Protocol constants shared with @gsalgadotoledo/rt-app-conformance.
const (
	Protocol = 1
	Ready    = "RT_CONTRACT_READY"
	Base     = "/rt-contract/v1"
)

// Method is a callable method. args are the raw wire values of the call's arguments;
// a method decodes and checks them itself, returning the module's errors for bad input.
type Method func(ctx context.Context, args []json.RawMessage) (any, error)

// Instance is a live object under test: an explicit method table (contract camelCase names)
// and an optional Close called when the runner deletes it.
type Instance struct {
	Methods map[string]Method
	Close   func() error
}

// Subject builds an instance from a case's init value (raw JSON; "{}" when omitted).
type Subject func(ctx context.Context, init json.RawMessage) (Instance, error)

// WireError is how a module error travels: contracts match status and message.
type WireError struct {
	Type    string `json:"type"`
	Status  int    `json:"status,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

// DescribeError converts an error; status comes from *apperr.HTTPError, code from a
// Code() string method.
func DescribeError(err error) WireError {
	w := WireError{Type: typeName(err), Message: err.Error()}
	if httpErr, ok := apperr.As(err); ok {
		w.Type, w.Status = "HTTPError", httpErr.Status
	}
	var coded interface{ Code() string }
	if errors.As(err, &coded) {
		w.Code = coded.Code()
	}
	return w
}

func typeName(err error) string {
	name := strings.TrimPrefix(fmt.Sprintf("%T", err), "*")
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		name = name[i+1:]
	}
	return name
}

var methodName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)

// maxInstances bounds live instances; runners delete them after each case.
const maxInstances = 1000

// Host serves subjects over the contract protocol. It implements http.Handler.
type Host struct {
	language string
	subjects map[string]Subject

	mu        sync.Mutex
	next      int
	instances map[string]Instance
}

// NewHost returns a host for the given subjects.
func NewHost(language string, subjects map[string]Subject) *Host {
	return &Host{language: language, subjects: subjects, instances: map[string]Instance{}}
}

type protocolError struct {
	status  int
	message string
}

func (e *protocolError) Error() string { return e.message }

func (h *Host) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	status, value, err := h.route(r)
	if err != nil {
		status = http.StatusInternalServerError
		var pe *protocolError
		if errors.As(err, &pe) {
			status = pe.status
		}
		value = map[string]string{"protocolError": err.Error()}
	}
	send(w, status, value)
}

func (h *Host) route(r *http.Request) (int, any, error) {
	// Only local tools talk to a host: refuse browser requests (they carry Origin).
	if r.Header.Get("Origin") != "" {
		return 0, nil, &protocolError{http.StatusForbidden, "Browsers may not call a contract host"}
	}
	rest, ok := strings.CutPrefix(r.URL.EscapedPath(), Base)
	if !ok {
		return 0, nil, &protocolError{http.StatusNotFound, "Not a contract host path"}
	}
	var parts []string
	for _, part := range strings.Split(rest, "/") {
		if part == "" {
			continue
		}
		decoded, err := url.PathUnescape(part)
		if err != nil {
			return 0, nil, err
		}
		parts = append(parts, decoded)
	}
	switch {
	case r.Method == http.MethodGet && len(parts) == 0:
		names := make([]string, 0, len(h.subjects))
		for name := range h.subjects {
			names = append(names, name)
		}
		slices.Sort(names)
		return http.StatusOK, map[string]any{"protocol": Protocol, "language": h.language, "runtime": runtime.Version(), "subjects": names}, nil
	case r.Method == http.MethodPost && len(parts) == 1 && parts[0] == "instances":
		return h.create(r)
	case len(parts) == 2 && parts[0] == "instances" && r.Method == http.MethodDelete:
		h.mu.Lock()
		instance, ok := h.instances[parts[1]]
		delete(h.instances, parts[1])
		h.mu.Unlock()
		if ok && instance.Close != nil {
			_ = instance.Close() // closing errors are not part of a case
		}
		return http.StatusOK, map[string]bool{"ok": true}, nil
	case len(parts) == 3 && parts[0] == "instances" && r.Method == http.MethodPost:
		return h.call(r, parts[1], parts[2])
	}
	return 0, nil, &protocolError{http.StatusNotFound, "Unknown contract host route"}
}

func (h *Host) create(r *http.Request) (int, any, error) {
	var request struct {
		Subject any             `json:"subject"`
		Init    json.RawMessage `json:"init"`
	}
	if err := readBody(r, &request); err != nil {
		return 0, nil, err
	}
	name, _ := request.Subject.(string)
	subject, ok := h.subjects[name]
	if !ok {
		return 0, nil, &protocolError{http.StatusNotFound, fmt.Sprintf("Unknown subject: %v", request.Subject)}
	}
	h.mu.Lock()
	full := len(h.instances) >= maxInstances
	h.mu.Unlock()
	if full {
		return 0, nil, &protocolError{http.StatusTooManyRequests, "Too many live instances; delete them after each case"}
	}
	init := request.Init
	if init == nil {
		init = json.RawMessage("{}")
	}
	instance, err := protect(func() (Instance, error) { return subject(r.Context(), init) })
	if err != nil {
		return http.StatusOK, map[string]any{"ok": false, "error": DescribeError(err)}, nil
	}
	h.mu.Lock()
	h.next++
	id := strconv.Itoa(h.next)
	h.instances[id] = instance
	h.mu.Unlock()
	return http.StatusOK, map[string]any{"ok": true, "id": id}, nil
}

func (h *Host) call(r *http.Request, id, name string) (int, any, error) {
	h.mu.Lock()
	instance, ok := h.instances[id]
	h.mu.Unlock()
	if !ok {
		return 0, nil, &protocolError{http.StatusNotFound, "Unknown instance: " + id}
	}
	method := instance.Methods[name]
	if !methodName.MatchString(name) || name == "constructor" || method == nil {
		return 0, nil, &protocolError{http.StatusNotFound, "Unknown method: " + name}
	}
	var request struct {
		Args json.RawMessage `json:"args"`
	}
	if err := readBody(r, &request); err != nil {
		return 0, nil, err
	}
	var args []json.RawMessage
	if request.Args != nil {
		if err := json.Unmarshal(request.Args, &args); err != nil {
			return 0, nil, &protocolError{http.StatusBadRequest, "args must be a list"}
		}
	}
	value, err := protect(func() (any, error) { return method(r.Context(), args) })
	if err != nil {
		return http.StatusOK, map[string]any{"ok": false, "error": DescribeError(err)}, nil
	}
	return http.StatusOK, map[string]any{"ok": true, "value": Encode(value)}, nil
}

// protect turns a panic into an error result, like a thrown exception in other languages.
func protect[T any](fn func() (T, error)) (value T, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return fn()
}

func readBody(r *http.Request, into any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 5<<20+1))
	if err != nil {
		return err
	}
	if len(raw) > 5<<20 {
		return &protocolError{http.StatusRequestEntityTooLarge, "Body too large"}
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return &protocolError{http.StatusBadRequest, "Invalid JSON"}
	}
	return nil
}

func send(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		body, _ = json.Marshal(map[string]string{"protocolError": err.Error()})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// Run serves the host on 127.0.0.1 (a free port), prints "RT_CONTRACT_READY <url>" to out
// and serves until ctx is canceled.
func Run(ctx context.Context, host *Host, out io.Writer) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: host, ReadHeaderTimeout: 10 * time.Second}
	stop := context.AfterFunc(ctx, func() { _ = server.Close() })
	defer stop()
	if _, err := fmt.Fprintf(out, "%s http://%s%s\n", Ready, ln.Addr(), Base); err != nil {
		_ = ln.Close()
		return err
	}
	if err := server.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
