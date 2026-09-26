package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// TOTP (RFC 6238): SHA-1, 6 digits, 30-second steps.
const totpPeriodMs = 30000

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

// NewTOTPSecret returns 20 random bytes as RFC 4648 base32 without padding (32 characters).
func NewTOTPSecret() string {
	raw := make([]byte, 20)
	_, _ = rand.Read(raw) // crypto/rand.Read never fails
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
}

// TOTPCode returns the six-digit code of secret (base32, uppercase, no padding) for a 30-second
// step. Trailing bits that do not fill a byte are ignored, as in the reference.
func TOTPCode(secret string, step uint64) (string, error) {
	var key []byte
	var acc, bits uint
	for _, c := range secret {
		i := strings.IndexRune(base32Alphabet, c)
		if i < 0 {
			return "", fmt.Errorf("auth: invalid base32 character %q in TOTP secret", c)
		}
		acc = acc<<5 | uint(i)
		bits += 5
		if bits >= 8 {
			key = append(key, byte(acc>>(bits-8)))
			bits -= 8
			acc &= 1<<bits - 1
		}
	}
	if len(key) == 0 {
		return "", errors.New("auth: empty TOTP secret")
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], step)
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[19] & 15
	value := binary.BigEndian.Uint32(sum[offset:]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000), nil
}

// TOTPStep returns the step code matches: the first of the current, previous and next steps
// that is greater than last (-1 at enrollment) and whose code equals code. ok is false for
// malformed codes and when nothing matches.
func TOTPStep(secret string, code any, last int64, nowMs int64) (step int64, ok bool, err error) {
	s, isString := code.(string)
	if !isString || !sixDigits(s) {
		return 0, false, nil
	}
	now := floorDiv(nowMs, totpPeriodMs)
	for _, candidate := range []int64{now, now - 1, now + 1} {
		if candidate <= last || candidate < 0 {
			continue
		}
		expected, err := TOTPCode(secret, uint64(candidate))
		if err != nil {
			return 0, false, err
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(s)) == 1 {
			return candidate, true, nil
		}
	}
	return 0, false, nil
}

// sixDigits is /^\d{6}$/ with ASCII digits only.
func sixDigits(s string) bool {
	if len(s) != 6 {
		return false
	}
	for i := 0; i < 6; i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Vault seals values stored in rows (TOTP seeds, pending challenges): AES-256-GCM with key
// SHA-256("rt-app-auth-vault:" + secret), stored as base64url(iv12 || tag16 || ciphertext) of
// the compact JSON. Values sealed by any RT-App language open in every other.
type Vault struct {
	aead cipher.AEAD
}

// NewVault returns the vault of an application secret.
func NewVault(secret string) *Vault {
	key := sha256.Sum256([]byte("rt-app-auth-vault:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		panic(err) // a 32-byte key is always valid
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &Vault{aead: aead}
}

// Seal encrypts the JSON of value with a random IV.
func (v *Vault) Seal(value any) (string, error) {
	plain, err := marshal(value)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	_, _ = rand.Read(iv)
	return v.seal(iv, plain), nil
}

func (v *Vault) seal(iv, plain []byte) string {
	sealed := v.aead.Seal(nil, iv, plain, nil) // ciphertext || tag
	n := len(sealed) - 16
	out := make([]byte, 0, 12+len(sealed))
	out = append(out, iv...)
	out = append(out, sealed[n:]...)
	out = append(out, sealed[:n]...)
	return base64.RawURLEncoding.EncodeToString(out)
}

// Open decrypts a sealed value and decodes its JSON (numbers are float64).
func (v *Vault) Open(sealed string) (any, error) {
	raw := looseBase64URL(sealed)
	if len(raw) < 28 {
		return nil, errors.New("auth: sealed value too short")
	}
	iv, tag, data := raw[:12], raw[12:28], raw[28:]
	plain, err := v.aead.Open(nil, iv, append(append([]byte{}, data...), tag...), nil)
	if err != nil {
		return nil, errors.New("auth: sealed value does not open with this secret")
	}
	var value any
	if err := json.Unmarshal(plain, &value); err != nil {
		return nil, err
	}
	return value, nil
}

// openSecret opens a sealed {secret} value.
func (v *Vault) openSecret(sealed any) (string, error) {
	s, _ := sealed.(string)
	value, err := v.Open(s)
	if err != nil {
		return "", err
	}
	object, _ := value.(map[string]any)
	secret, ok := object["secret"].(string)
	if !ok {
		return "", errors.New("auth: sealed value has no secret")
	}
	return secret, nil
}

// looseBase64URL decodes like Node's Buffer.from(s, "base64url"): both alphabets, other
// characters skipped, decoding stops at "=", and a dangling final character is dropped.
func looseBase64URL(s string) []byte {
	var clean strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			i = len(s)
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9':
			clean.WriteByte(c)
		case c == '-' || c == '+':
			clean.WriteByte('-')
		case c == '_' || c == '/':
			clean.WriteByte('_')
		}
	}
	text := clean.String()
	if len(text)%4 == 1 {
		text = text[:len(text)-1]
	}
	out, _ := base64.RawURLEncoding.DecodeString(text)
	return out
}

// marshal is compact JSON without HTML escaping, like JSON.stringify.
func marshal(value any) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return []byte(strings.TrimSuffix(b.String(), "\n")), nil
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}
