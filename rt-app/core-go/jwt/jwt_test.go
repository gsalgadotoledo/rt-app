package jwt

import (
	"errors"
	"testing"
	"time"

	"rt.local/core-go/apperr"
)

const (
	secret = "rt-app-contract-secret-0123456789abcdef"
	// Issued by the TypeScript reference for {id: "user-1", tokenVersion: 1} at the clock below.
	reference = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJydC1hcHAiLCJhdWQiOiJydC1hcHAtYXBpIiwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOjE3NjczMjM5NDV9.cKpp1WKANeBYqmOeu2NSuKbCgBCLFDl69JlwJG3CCfY"
)

func clock(iso string) func() time.Time {
	at, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		panic(err)
	}
	return func() time.Time { return at }
}

func TestIssueMatchesReference(t *testing.T) {
	tokens, err := New(secret, WithClock(clock("2026-01-02T03:04:05.999Z")))
	if err != nil {
		t.Fatal(err)
	}
	if got := tokens.Issue(User{ID: "user-1", TokenVersion: 1}); got != reference {
		t.Fatalf("got %s", got)
	}
	unicode := tokens.Issue(User{ID: "usuario-ñ-😀", TokenVersion: 42})
	if unicode != "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2Ijo0Miwic3ViIjoidXN1YXJpby3DsS3wn5iAIiwiaXNzIjoicnQtYXBwIiwiYXVkIjoicnQtYXBwLWFwaSIsImlhdCI6MTc2NzMyMzA0NSwiZXhwIjoxNzY3MzIzOTQ1fQ.R2nPnvYWoQn8fCKhg0D2D1aYQNsA_JfcLkYyGL2Lycw" {
		t.Fatalf("unicode: %s", unicode)
	}
	claims, err := tokens.Verify(unicode)
	if err != nil || claims != (Claims{ID: "usuario-ñ-😀", Version: 42}) {
		t.Fatalf("round trip: %v %v", claims, err)
	}
}

func TestVerifyExpiry(t *testing.T) {
	for iso, valid := range map[string]bool{"2026-01-02T03:19:04.999Z": true, "2026-01-02T03:19:05.000Z": false} {
		tokens, _ := New(secret, WithClock(clock(iso)))
		_, err := tokens.Verify(reference)
		var httpErr *apperr.HTTPError
		if valid != (err == nil) || !valid && (!errors.As(err, &httpErr) || httpErr.Status != 401 || httpErr.Message != "Invalid or expired session") {
			t.Errorf("%s: %v", iso, err)
		}
	}
}

func TestVerifyRejects(t *testing.T) {
	tokens, _ := New(secret, WithClock(clock("2026-01-02T03:04:05.000Z")))
	for _, token := range []string{"", "not.a.jwt", "Bearer " + reference, reference + "x", reference[:len(reference)-44],
		// alg none; HS512 with the right secret; crit with an unknown extension
		"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ2IjoxLCJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJydC1hcHAiLCJhdWQiOiJydC1hcHAtYXBpIiwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOjE3NjczMjM5NDV9.",
		"eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJydC1hcHAiLCJhdWQiOiJydC1hcHAtYXBpIiwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOjE3NjczMjM5NDV9.nggAwqTvT7LyRkm9ATywRjZiOMs-rN0OuwGAI8-XEdk7TDj7Oq-DvMdBRty89kYavf_TvIW4NueaScOr3Bwgtg",
	} {
		if _, err := tokens.Verify(token); err == nil {
			t.Errorf("accepted %q", token)
		}
	}
	crit := b64(`{"alg":"HS256","crit":["exp"]}`) + "." + b64(`{"v":1,"sub":"u","iss":"rt-app","aud":"rt-app-api","iat":1,"exp":9999999999}`)
	if _, err := tokens.Verify(crit + "." + b64(string(tokens.sign(crit)))); err == nil {
		t.Error("unknown crit accepted")
	}
}

func TestShortSecret(t *testing.T) {
	if _, err := New("ééééééééééééééé"); !errors.Is(err, ErrShortSecret) {
		t.Fatal(err)
	}
	if _, err := New("😀😀😀😀😀😀😀😀"); err != nil {
		t.Fatal(err)
	}
}
