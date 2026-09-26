package users

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strings"

	"golang.org/x/crypto/scrypt"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
)

// scrypt parameters of the reference (Node's crypto.scrypt with maxmem 64 MiB).
const (
	scryptN      = 32768
	scryptR      = 8
	scryptP      = 3
	scryptKeyLen = 64
)

// PasswordMessage is the 400 message of passwords outside 12..128 UTF-16 code units.
const PasswordMessage = "The password must contain 12 to 128 characters"

// ValidatePassword accepts a string of 12 to 128 UTF-16 code units, without trimming or
// Unicode normalization; anything else is 400 PasswordMessage.
func ValidatePassword(password any) error {
	s, ok := password.(string)
	if !ok || js.Len(s) < 12 || js.Len(s) > 128 {
		return apperr.BadRequest(PasswordMessage)
	}
	return nil
}

// HashPassword validates password and returns "scrypt$<salt>$<hex>": the salt is 16 random
// bytes as 32 lowercase hex characters, and scrypt uses that hex TEXT (its UTF-8 bytes) as salt.
func HashPassword(password any) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(raw)
	key, err := derive(password.(string), salt)
	if err != nil {
		return "", err
	}
	return "scrypt$" + salt + "$" + hex.EncodeToString(key), nil
}

// VerifyPassword reports whether password matches a stored hash. Non-strings and passwords
// longer than 128 units are false without hashing. The digest compares in constant time; its
// hex may use either case, the salt is text and must match exactly. A stored value without
// a salt or digest is an error, as in the reference.
func VerifyPassword(password any, stored string) (bool, error) {
	s, ok := password.(string)
	if !ok || js.Len(s) > 128 {
		return false, nil
	}
	parts := strings.Split(stored, "$")
	if len(parts) < 2 {
		return false, errors.New("users: stored password hash has no salt")
	}
	key, err := derive(s, parts[1])
	if err != nil {
		return false, err
	}
	if len(parts) < 3 {
		return false, errors.New("users: stored password hash has no digest")
	}
	expected := looseHex(parts[2])
	return len(expected) == len(key) && subtle.ConstantTimeCompare(key, expected) == 1, nil
}

func derive(password, salt string) ([]byte, error) {
	return scrypt.Key([]byte(password), []byte(salt), scryptN, scryptR, scryptP, scryptKeyLen)
}

// looseHex decodes like Node's Buffer.from(s, "hex"): byte pairs until the first invalid one.
func looseHex(s string) []byte {
	out := make([]byte, 0, len(s)/2)
	for i := 0; i+1 < len(s); i += 2 {
		b, err := hex.DecodeString(s[i : i+2])
		if err != nil {
			break
		}
		out = append(out, b[0])
	}
	return out
}
