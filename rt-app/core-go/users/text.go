package users

import (
	"strings"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
)

// Text validates a required text field like the reference's text(value, field, max): a string
// that is not blank after JavaScript trim() and has at most max UTF-16 units BEFORE trimming.
// It returns the trimmed value, or 400 "Invalid field: <field>".
func Text(value any, field string, max int) (string, error) {
	s, ok := value.(string)
	if !ok || js.Trim(s) == "" || js.Len(s) > max {
		return "", apperr.BadRequest("Invalid field: " + field)
	}
	return js.Trim(s), nil
}

// EmailAddress normalizes an email like the reference: Text(value, "email", 254), JavaScript
// toLowerCase, then ^[^\s@]+@[^\s@]+\.[^\s@]+$ with the JavaScript \s set (400 "Invalid email").
func EmailAddress(value any) (string, error) {
	s, err := Text(value, "email", 254)
	if err != nil {
		return "", err
	}
	email := js.ToLower(s)
	if !validEmail(email) {
		return "", apperr.BadRequest("Invalid email")
	}
	return email, nil
}

func validEmail(s string) bool {
	if strings.ContainsFunc(s, js.IsSpace) || strings.Count(s, "@") != 1 {
		return false
	}
	local, domain, _ := strings.Cut(s, "@")
	if local == "" {
		return false
	}
	// [^\s@]+\.[^\s@]+ : a dot that is neither the first nor the last character.
	for i := 1; i < len(domain)-1; i++ {
		if domain[i] == '.' {
			return true
		}
	}
	return false
}
