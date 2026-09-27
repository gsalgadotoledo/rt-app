package analytics

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"strings"
	"testing"
)

type key struct{}

type spy struct{ calls []string }

func (s *spy) WithContext(ctx context.Context, fields map[string]string) context.Context {
	merged, _ := ctx.Value(key{}).(map[string]string)
	merged = maps.Clone(merged)
	if merged == nil {
		merged = map[string]string{}
	}
	maps.Copy(merged, fields)
	return context.WithValue(ctx, key{}, merged)
}

func (s *spy) Emit(ctx context.Context, level, kind, source, message string, data map[string]any) error {
	fields := ctx.Value(key{}).(map[string]string)
	s.calls = append(s.calls, strings.Join([]string{"emit", level, kind, source, message, fields["category"], fields["requestId"]}, " "))
	if data == nil {
		return errors.New("nil data")
	}
	return nil
}

func (s *spy) CountView(ctx context.Context, message string, view View) error {
	s.calls = append(s.calls, strings.Join([]string{"view", message, view.URL, ctx.Value(key{}).(map[string]string)["category"]}, " "))
	return nil
}

func TestTrackAndPageViewDelegateInTheAnalyticsCategory(t *testing.T) {
	observer := &spy{}
	a := New(observer)
	ctx := observer.WithContext(context.Background(), map[string]string{"requestId": "r1", "category": "http"})
	if err := a.Track(ctx, "checkout.completed", map[string]any{"plan": "pro"}, "web"); err != nil {
		t.Fatal(err)
	}
	if err := a.Track(ctx, "signup", nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := a.PageView(ctx, "Home", View{URL: "/"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"emit info analytics web checkout.completed analytics r1", "emit info analytics app signup analytics r1", "view Home / analytics"}
	if !reflect.DeepEqual(observer.calls, want) {
		t.Fatalf("calls = %q", observer.calls)
	}
}

func TestNamesAreStableASCIIIdentifiers(t *testing.T) {
	observer := &spy{}
	a := New(observer)
	for _, name := range []string{"bad name", "1st", "", "a\n", "café", "xK", strings.Repeat("a", 81)} {
		if err := a.Track(context.Background(), name, nil, ""); !errors.Is(err, ErrInvalidName) {
			t.Errorf("%q: err = %v", name, err)
		}
	}
	for _, name := range []string{strings.Repeat("a", 80), "aZ09._-"} {
		if err := a.Track(context.Background(), name, nil, ""); err != nil {
			t.Errorf("%q: %v", name, err)
		}
	}
	if len(observer.calls) != 2 {
		t.Fatalf("calls = %q", observer.calls)
	}
}
