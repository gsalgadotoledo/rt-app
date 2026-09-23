package rtcore

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

type client struct{ name string }

func TestConcurrentSingletonAndIsolation(t *testing.T) {
	var calls atomic.Int32
	p := New(func() (*client, error) { calls.Add(1); return &client{"one"}, nil })
	var wg sync.WaitGroup
	values := make(chan *client, 64)
	for range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, e := p.Get()
			if e != nil {
				t.Error(e)
			}
			values <- v
		}()
	}
	wg.Wait()
	close(values)
	first, _ := p.Get()
	for v := range values {
		if v != first {
			t.Fatal("different instances")
		}
	}
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
	other := New(func() (*client, error) { return &client{"two"}, nil })
	v, _ := other.Get()
	if v == first {
		t.Fatal("applications share instance")
	}
}
func TestFailureStickyAndUnusedClose(t *testing.T) {
	calls := 0
	want := errors.New("offline")
	p := New(func() (*client, error) { calls++; return nil, want })
	for range 2 {
		if _, e := p.Get(); !errors.Is(e, want) {
			t.Fatal(e)
		}
	}
	if calls != 1 {
		t.Fatal(calls)
	}
	unused := New(func() (int, error) { t.Fatal("unused initialized"); return 1, nil })
	if e := unused.Close(); e != nil {
		t.Fatal(e)
	}
	if _, e := unused.Get(); !errors.Is(e, ErrClosed) {
		t.Fatal(e)
	}
}
func TestCloseWaitsForInitializationAndRunsOnce(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var closed atomic.Int32
	want := errors.New("close failed")
	p := New(func() (*client, error) { close(entered); <-release; return &client{}, nil }, WithClose(func(*client) error { closed.Add(1); return want }))
	finished := make(chan struct{})
	go func() { defer close(finished); _, _ = p.Get() }()
	<-entered
	closing := make(chan error)
	go func() { closing <- p.Close() }()
	close(release)
	<-finished
	if e := <-closing; !errors.Is(e, want) {
		t.Fatal(e)
	}
	if !errors.Is(p.Close(), want) || closed.Load() != 1 {
		t.Fatal("cleanup repeated")
	}
	if _, e := p.Get(); !errors.Is(e, ErrClosed) {
		t.Fatal(e)
	}
}
func TestPanicRemainsSticky(t *testing.T) {
	calls := 0
	p := New(func() (int, error) { calls++; panic("bad factory") })
	for range 2 {
		func() {
			defer func() {
				if recover() != "bad factory" {
					t.Fatal("panic was lost")
				}
			}()
			_, _ = p.Get()
		}()
	}
	if calls != 1 {
		t.Fatal(calls)
	}
	if e := p.Close(); e != nil {
		t.Fatal(e)
	}
}
