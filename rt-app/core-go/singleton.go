// Package rtcore provides typed, application-owned singleton providers.
// Compose dependencies with ordinary constructors; there is no global registry.
package rtcore

import (
	"errors"
	"sync"
)

var ErrClosed = errors.New("rt-app: provider is closed")

// Factory captures configuration and dependencies at the composition root.
// On failure it must clean up any partially allocated resources itself.
type Factory[T any] func() (T, error)

type Option[T any] func(*Singleton[T])

// WithClose registers cleanup for a successfully constructed value. Stop serving
// requests before Close: the provider cannot track clients using a returned value.
func WithClose[T any](close func(T) error) Option[T] {
	return func(s *Singleton[T]) { s.cleanup = close }
}

// Singleton creates at most one value per provider, not per OS process.
// Its synchronization protects initialization and shutdown, not the component's methods.
// It must not be copied after first use.
type Singleton[T any] struct {
	mu         sync.RWMutex
	initialize func() (T, error)
	value      T
	ready      bool
	closed     bool
	cleanup    func(T) error
	closeError error
}

// New stores a lazy factory. Options are evaluated now; the factory is evaluated
// on the first Get. Initialization errors and panics are sticky (sync.OnceValues).
// To retry or change adapters, create a new provider. Do not resolve this provider
// recursively from its own factory or create cycles between provider factories.
func New[T any](factory Factory[T], options ...Option[T]) *Singleton[T] {
	if factory == nil {
		panic("rt-app: nil factory")
	}
	s := &Singleton[T]{}
	for _, option := range options {
		option(s)
	}
	s.initialize = sync.OnceValues(func() (T, error) {
		value, err := factory()
		if err == nil {
			s.value = value
			s.ready = true
		}
		return value, err
	})
	return s
}

func (s *Singleton[T]) Get() (T, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		var zero T
		return zero, ErrClosed
	}
	return s.initialize()
}

// Close never initializes an unused provider. Cleanup runs at most once; its
// error is returned on subsequent calls. Close dependencies after their consumers.
func (s *Singleton[T]) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.closeError
	}
	s.closed = true
	if s.ready && s.cleanup != nil {
		s.closeError = s.cleanup(s.value)
	}
	return s.closeError
}
