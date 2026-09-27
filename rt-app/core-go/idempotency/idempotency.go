// Package idempotency runs side effects at most once per (scope, key) (port of
// @gsalgadotoledo/rt-app-idempotency).
//
// Compose it in main.go and inject it into the modules that charge, send or create things:
//
//	idem := rtcore.New(func() (*idempotency.Executor, error) { return idempotency.NewNoSQL(store.Get()), nil })
//	receipt, err := idem.Get().Execute(ctx, idempotency.Request{Scope: scope, Key: orderID, Input: body},
//		func(ctx context.Context, c idempotency.Context) (any, error) { return gateway.Charge(ctx, c.Input, c.IdempotencyKey) })
//
// Semantics shared with TypeScript (see rt-app/docs/polyglot/idempotency.md): the first call
// claims (scope, key) atomically as pending before running the work and stores its JSON result
// as completed; retries with the same input replay it without running the work; another input
// is CONFLICT and an unfinished claim is PENDING. A failed work or failed completion marks the
// claim uncertain and returns UNCERTAIN: the side effect may have happened and must be
// reconciled, never retried automatically. Nothing expires and nothing is taken over.
package idempotency

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
)

// Code identifies an idempotency failure.
type Code string

// Error codes (RTAppIdempotencyError).
const (
	NotConfigured Code = "NOT_CONFIGURED"
	InvalidJSON   Code = "INVALID_JSON"
	InvalidKey    Code = "INVALID_KEY"
	Pending       Code = "PENDING"
	Uncertain     Code = "UNCERTAIN"
	Conflict      Code = "CONFLICT"
)

// Limits in UTF-16 code units.
const (
	MaxScopeLength = 512
	MaxKeyLength   = 256
)

// Error is an idempotency failure: "RT-App idempotency: <code>". Cause is the work or store
// error behind UNCERTAIN.
type Error struct {
	code  Code
	Cause error
}

// NewError returns an *Error with code.
func NewError(code Code) *Error { return &Error{code: code} }

func (e *Error) Error() string { return "RT-App idempotency: " + string(e.code) }

// Code returns the error code (the contract host reports it).
func (e *Error) Code() string { return string(e.code) }

// Unwrap returns the cause.
func (e *Error) Unwrap() error { return e.Cause }

// Is matches another *Error with the same code: errors.Is(err, idempotency.NewError(idempotency.Pending)).
func (e *Error) Is(target error) bool {
	var other *Error
	return errors.As(target, &other) && other.code == e.code
}

// IsCode reports whether err is an idempotency error with code.
func IsCode(err error, code Code) bool {
	var e *Error
	return errors.As(err, &e) && e.code == code
}

// Claim identifies one execution attempt.
type Claim struct {
	Scope       string `json:"scope"`
	Key         string `json:"key"`
	Fingerprint string `json:"fingerprint"`
	Owner       string `json:"owner"`
}

// State of a claim as the store reports it.
type State string

// Claim states.
const (
	Acquired       State = "acquired"
	StatePending   State = "pending"
	StateUncertain State = "uncertain"
	StateConflict  State = "conflict"
	Completed      State = "completed"
)

// Decision is the answer to a claim; Result is set when State is Completed.
type Decision struct {
	State  State `json:"state"`
	Result any   `json:"result,omitempty"`
	// HasResult tells a stored null result from a missing one.
	HasResult bool `json:"-"`
}

// Store persists claims. Implementations MUST claim atomically and persist before returning
// Acquired.
type Store interface {
	Claim(ctx context.Context, claim Claim) (Decision, error)
	Complete(ctx context.Context, claim Claim, result any) error
	MarkUncertain(ctx context.Context, claim Claim) error
}

// Request is one operation: Scope names the application, authenticated actor, operation and
// contract version; Key is the stable operation id reused on every retry; Input is JSON.
type Request struct {
	Scope string
	Key   string
	Input any
	// NoInput marks an absent input (JavaScript undefined), which is not JSON.
	NoInput bool
}

// Context is what the work receives: the input snapshot (decoded JSON) and the key to forward
// to the provider.
type Context struct {
	Input          any
	IdempotencyKey string
}

// Work performs the side effect once.
type Work func(ctx context.Context, c Context) (any, error)

// Executor is RTAppIdempotencyModule. The zero value has no store and fails with NOT_CONFIGURED.
type Executor struct {
	Store Store
}

// New returns an executor over store.
func New(store Store) *Executor { return &Executor{Store: store} }

// NewNoSQL returns an executor over a NoSQLStore on store.
func NewNoSQL(store nosql.Store, opts ...Option) *Executor { return New(NewNoSQLStore(store, opts...)) }

// Init fails fast when no store is configured.
func (e *Executor) Init() error {
	if e == nil || e.Store == nil {
		return NewError(NotConfigured)
	}
	return nil
}

func invalidJSON(canonical.Kind) error { return NewError(InvalidJSON) }

// Canonical is the canonical JSON of an input (sorted keys, JavaScript numbers).
func Canonical(v any) (string, error) { return canonical.Marshal(v, invalidJSON) }

// Fingerprint is the sha256 hex of the canonical input.
func Fingerprint(input any) (string, error) {
	text, err := Canonical(input)
	if err != nil {
		return "", err
	}
	return canonical.SHA256Hex(text), nil
}

// Key is the provider idempotency key: "rtapp-" + sha256hex(JSON.stringify([scope, key])).
func Key(scope, key string) string {
	return "rtapp-" + canonical.SHA256Hex("["+canonical.Quote(scope)+","+canonical.Quote(key)+"]")
}

func validText(s string, limit int) bool {
	return js.Trim(s) != "" && js.Len(s) <= limit
}

// Execute runs work once for request and replays its stored result afterwards.
func (e *Executor) Execute(ctx context.Context, request Request, work Work) (any, error) {
	if err := e.Init(); err != nil {
		return nil, err
	}
	if !validText(request.Scope, MaxScopeLength) || !validText(request.Key, MaxKeyLength) {
		return nil, NewError(InvalidKey)
	}
	if request.NoInput {
		return nil, NewError(InvalidJSON)
	}
	serialized, err := Canonical(request.Input)
	if err != nil {
		return nil, err
	}
	snapshot, err := canonical.Parse(serialized)
	if err != nil {
		return nil, err
	}
	claim := Claim{Scope: request.Scope, Key: request.Key, Fingerprint: canonical.SHA256Hex(serialized), Owner: uuid.New()}
	decision, err := e.Store.Claim(ctx, claim)
	if err != nil {
		return nil, err
	}
	switch decision.State {
	case Completed:
		if !decision.HasResult {
			return nil, NewError(InvalidJSON)
		}
		return canonical.Clone(decision.Result, invalidJSON)
	case Acquired:
	case StatePending, StateUncertain, StateConflict:
		return nil, NewError(Code(strings.ToUpper(string(decision.State))))
	default:
		return nil, fmt.Errorf("idempotency: unknown claim state %q", decision.State)
	}
	result, err := e.run(ctx, work, Context{Input: snapshot, IdempotencyKey: Key(request.Scope, request.Key)})
	if err == nil {
		if result, err = canonical.Clone(result, invalidJSON); err == nil {
			if err = e.Store.Complete(ctx, claim, result); err == nil {
				return result, nil
			}
		}
	}
	// Never remove a claim on failure: the remote side effect may have succeeded, and a failed
	// completion acknowledgement may also mean the completion was persisted.
	_ = e.Store.MarkUncertain(context.WithoutCancel(ctx), claim) // on failure the claim stays pending
	return nil, &Error{code: Uncertain, Cause: err}
}

// run calls work, turning a panic into an error so the claim is still marked uncertain.
func (e *Executor) run(ctx context.Context, work Work, c Context) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("idempotency: work panicked: %v", r)
		}
	}()
	return work(ctx, c)
}

// Idempotent is the optional embeddable helper (RTAppIdempotentModule).
type Idempotent struct {
	Idempotency *Executor
}

// ExecuteIdempotent delegates to the executor, or fails with NOT_CONFIGURED without one.
func (m *Idempotent) ExecuteIdempotent(ctx context.Context, request Request, work Work) (any, error) {
	if m.Idempotency == nil {
		return nil, NewError(NotConfigured)
	}
	return m.Idempotency.Execute(ctx, request, work)
}

// Option configures a NoSQLStore.
type Option func(*NoSQLStore)

// WithClock sets the clock for createdAt/updatedAt (default time.Now).
func WithClock(now func() time.Time) Option { return func(s *NoSQLStore) { s.now = now } }

// NoSQLStore keeps claims in a NoSQL store: pk "IDEMPOTENCY#" + scope, sk key. Never expires.
type NoSQLStore struct {
	store nosql.Store
	now   func() time.Time
}

// NewNoSQLStore returns a claim store on store.
func NewNoSQLStore(store nosql.Store, opts ...Option) *NoSQLStore {
	s := &NoSQLStore{store: store, now: time.Now}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

func (s *NoSQLStore) timestamp() string {
	return s.now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func address(claim Claim) (string, string) { return "IDEMPOTENCY#" + claim.Scope, claim.Key }

// Claim creates the pending row, or reports the state of the existing one.
func (s *NoSQLStore) Claim(ctx context.Context, claim Claim) (Decision, error) {
	pk, sk := address(claim)
	err := s.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: pk, SK: sk, Version: 1, Data: map[string]any{
		"fingerprint": claim.Fingerprint,
		"owner":       claim.Owner,
		"state":       "pending",
		"createdAt":   s.timestamp(),
	}}}})
	if err == nil {
		return Decision{State: Acquired}, nil
	}
	if !apperr.IsConflict(err) {
		return Decision{}, err
	}
	row, getErr := s.store.Get(ctx, pk, sk)
	if getErr != nil {
		return Decision{}, getErr
	}
	if row == nil {
		return Decision{}, err
	}
	if !js.Equal(row.Data["fingerprint"], claim.Fingerprint) {
		return Decision{State: StateConflict}, nil
	}
	switch row.Data["state"] {
	case "completed":
		result, has := row.Data["result"]
		return Decision{State: Completed, Result: result, HasResult: has}, nil
	case "uncertain":
		return Decision{State: StateUncertain}, nil
	default:
		return Decision{State: StatePending}, nil
	}
}

// Complete saves a replayable result, only for the owner of the claim.
func (s *NoSQLStore) Complete(ctx context.Context, claim Claim, result any) error {
	return s.transition(ctx, claim, "completed", result)
}

// MarkUncertain marks the claim uncertain; a completed row is never overwritten.
func (s *NoSQLStore) MarkUncertain(ctx context.Context, claim Claim) error {
	return s.transition(ctx, claim, "uncertain", nil)
}

func (s *NoSQLStore) transition(ctx context.Context, claim Claim, state string, result any) error {
	pk, sk := address(claim)
	row, err := s.store.Get(ctx, pk, sk)
	if err != nil {
		return err
	}
	if row == nil || !js.Equal(row.Data["owner"], claim.Owner) || !js.Equal(row.Data["fingerprint"], claim.Fingerprint) {
		return apperr.Conflict()
	}
	if row.Data["state"] == "completed" {
		return nil
	}
	data := make(map[string]any, len(row.Data)+2)
	for k, v := range row.Data {
		data[k] = v
	}
	data["state"] = state
	data["updatedAt"] = s.timestamp()
	if state == "completed" {
		data["result"] = result
	}
	next := *row
	next.Version = row.Version + 1
	next.Data = data
	return s.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}})
}
