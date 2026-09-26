package featureflags

import (
	"encoding/json"
	"math"
)

// Loosely-typed input (HTTP bodies, contract arguments) is checked with JavaScript typeof
// semantics before it reaches the typed API: true is not a number, "50" is not a number,
// 1.5 is not a version. Values are decoded JSON (numbers are float64).

// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 1<<53 - 1

// ParseDefinition decodes a definition object; wrong types return ErrInvalidConfig.
func ParseDefinition(raw json.RawMessage) (Definition, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return Definition{}, ErrInvalidConfig
	}
	return DefinitionFrom(value)
}

// DefinitionFrom checks a decoded JSON object: description string, enabled and public
// booleans, rollout a number and subjects an array of strings. Limits are checked by Save.
func DefinitionFrom(value any) (Definition, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return Definition{}, ErrInvalidConfig
	}
	var def Definition
	var okDescription, okEnabled, okPublic, okRollout bool
	def.Description, okDescription = object["description"].(string)
	def.Enabled, okEnabled = object["enabled"].(bool)
	def.Public, okPublic = object["public"].(bool)
	def.Rollout, okRollout = object["rollout"].(float64)
	list, okSubjects := object["subjects"].([]any)
	if !okDescription || !okEnabled || !okPublic || !okRollout || !okSubjects {
		return Definition{}, ErrInvalidConfig
	}
	def.Subjects = make([]string, 0, len(list))
	for _, item := range list {
		s, ok := item.(string)
		if !ok {
			return Definition{}, ErrInvalidConfig
		}
		def.Subjects = append(def.Subjects, s)
	}
	return def, nil
}

// ParseVersion decodes a version argument: null creates, a positive safe integer updates.
func ParseVersion(raw json.RawMessage) (*int, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, ErrInvalidConfig
	}
	return VersionFrom(value, true)
}

// VersionFrom checks a decoded version. present is false when the field or argument is
// missing, which JavaScript sees as undefined and rejects (only null means "create").
func VersionFrom(value any, present bool) (*int, error) {
	if !present {
		return nil, ErrInvalidConfig
	}
	if value == nil {
		return nil, nil
	}
	n, ok := value.(float64)
	if !ok || n != math.Trunc(n) || n <= 0 || n > maxSafeInteger {
		return nil, ErrInvalidConfig
	}
	version := int(n)
	return &version, nil
}

// ParseSubject decodes a subject argument; see SubjectFrom.
func ParseSubject(raw json.RawMessage) (string, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", ErrInvalidSubject
	}
	return SubjectFrom(value, true)
}

// SubjectFrom checks a decoded subject. A missing subject is ""; anything but a string
// (null included, as in JavaScript default parameters) returns ErrInvalidSubject.
func SubjectFrom(value any, present bool) (string, error) {
	if !present {
		return "", nil
	}
	s, ok := value.(string)
	if !ok {
		return "", ErrInvalidSubject
	}
	return s, nil
}

// ParseKey decodes a key argument; anything but a valid key string returns ErrInvalidKey.
func ParseKey(raw json.RawMessage) (string, error) {
	var key string
	if err := json.Unmarshal(raw, &key); err != nil {
		return "", ErrInvalidKey
	}
	return key, ValidateKey(key)
}
