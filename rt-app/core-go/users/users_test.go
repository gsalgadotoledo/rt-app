package users

import (
	"context"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// A hash written by the TypeScript reference for "correct horse battery".
const referenceHash = "scrypt$00112233445566778899aabbccddeeff$57312542235f0bd20de68ba91435932724a28fb139d398248a941a31002a374c4b90936648d12a0fb3257c32d78b4f18d168bc11152ad26e7a4da912dfeae2d3"

func status(err error) (int, string) {
	if e, ok := apperr.As(err); ok {
		return e.Status, e.Message
	}
	return 0, ""
}

func TestEmailAddress(t *testing.T) {
	valid := map[string]string{
		"  Alice@Example.TEST ":      "alice@example.test",
		"İNCI@EXAMPLE.TEST":          "i\u0307nci@example.test",
		"\ufeff bob@example.test \n": "bob@example.test",
		"dan\u200b@example.test":     "dan\u200b@example.test",
		"eve@example.test\u0085":     "eve@example.test\u0085",
	}
	for in, want := range valid {
		if got, err := EmailAddress(in); err != nil || got != want {
			t.Errorf("EmailAddress(%q) = %q, %v", in, got, err)
		}
	}
	for in, message := range map[any]string{nil: "Invalid field: email", 5.0: "Invalid field: email", "   ": "Invalid field: email",
		"a@b": "Invalid email", "a b@x.y": "Invalid email", "a\u00a0b@x.y": "Invalid email", "a\u2028b@x.y": "Invalid email",
		"a@@x.y": "Invalid email", "@x.y": "Invalid email", "a@.y": "Invalid email", "a@x.": "Invalid email",
		" " + strings.Repeat("a", 241) + "@example.test": "Invalid field: email"} {
		if _, err := EmailAddress(in); err == nil || err.Error() != message {
			t.Errorf("EmailAddress(%q): %v, want %s", in, err, message)
		}
	}
}

func TestPasswords(t *testing.T) {
	for in, ok := range map[any]bool{"123456789012": true, "12345678901": false, "😀😀😀😀😀😀": true, "😀😀😀😀😀x": false,
		strings.Repeat("😀", 64): true, strings.Repeat("😀", 65): false, "            ": true, 123456789012.0: false, nil: false} {
		if err := ValidatePassword(in); (err == nil) != ok {
			t.Errorf("ValidatePassword(%q) = %v", in, err)
		}
	}
	for stored, want := range map[string]bool{
		referenceHash: true,
		strings.ToUpper(referenceHash[:7]) + referenceHash[7:]:   true,  // the "scrypt" tag is not checked
		referenceHash[:40] + strings.ToUpper(referenceHash[40:]): true,  // digest hex is case-insensitive
		strings.Replace(referenceHash, "aabbcc", "AABBCC", 1):    false, // the salt is text
		referenceHash[:len(referenceHash)-2]:                     false,
	} {
		if got, err := VerifyPassword("correct horse battery", stored); err != nil || got != want {
			t.Errorf("VerifyPassword(%s) = %v, %v", stored, got, err)
		}
	}
	if ok, _ := VerifyPassword(nil, referenceHash); ok {
		t.Error("nil password verified")
	}
	if _, err := VerifyPassword("correct horse battery", "plain"); err == nil {
		t.Error("a hash without salt must be an error")
	}
	hash, err := HashPassword("contraseña-😀-segura")
	if err != nil || !strings.HasPrefix(hash, "scrypt$") || len(hash) != 7+32+1+128 {
		t.Fatalf("HashPassword = %q, %v", hash, err)
	}
	if ok, err := VerifyPassword("contraseña-😀-segura", hash); !ok || err != nil {
		t.Fatal("own hash does not verify")
	}
}

func TestCreateProfileAndBootstrap(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	accounts := New(nosql.NewMemoryStore(), WithClock(func() time.Time { return at }))
	owner, err := accounts.BootstrapOwner(ctx, map[string]any{"email": "Owner@Example.test", "name": " Owner ", "password": "correct horse battery"})
	if err != nil {
		t.Fatal(err)
	}
	if owner.Data["role"] != RoleOwner || owner.Data["email"] != "owner@example.test" || owner.Data["createdAt"] != "2026-01-02T03:04:05.000Z" || owner.Data["createdBy"] != owner.SK {
		t.Fatalf("owner row: %+v", owner)
	}
	if _, err := accounts.BootstrapOwner(ctx, map[string]any{"email": "b@example.test", "name": "B", "password": "correct horse battery"}); err == nil {
		t.Fatal("second bootstrap accepted")
	}
	if _, err := accounts.Create(ctx, map[string]any{"email": " OWNER@example.test", "name": "X", "password": "correct horse battery"}, "", ""); err == nil || err.Error() != apperr.ConflictMessage {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, err := accounts.Create(ctx, map[string]any{"email": "bad", "name": "", "password": "x"}, "", ""); err == nil || err.Error() != "Invalid email" {
		t.Fatalf("validation order: %v", err)
	}
	view, err := accounts.Profile(ctx, owner.SK, map[string]any{"name": "  Boss "}, "admin-1")
	if err != nil || view["name"] != "Boss" || view["updatedBy"] != "admin-1" || view["passwordHash"] != nil {
		t.Fatalf("profile: %v %v", view, err)
	}
	if _, has := view["tokenVersion"]; has {
		t.Error("view leaks tokenVersion")
	}
	if code, _ := status(func() error { _, err := accounts.Profile(ctx, owner.SK, map[string]any{"email": "x"}, ""); return err }()); code != 400 {
		t.Error("profile edited more than the name")
	}
	if code, _ := status(func() error { _, err := accounts.Profile(ctx, "missing", map[string]any{"email": "x"}, ""); return err }()); code != 404 {
		t.Error("existence is checked first")
	}
}
