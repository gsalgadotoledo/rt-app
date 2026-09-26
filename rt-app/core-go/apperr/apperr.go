// Package apperr defines the errors that RT-App modules return to clients.
//
// An *HTTPError carries a status and a message that is safe to show; web adapters answer it
// as {"error": message}. Any other error is an internal error (500, logged, never shown).
package apperr

import (
	"errors"
	"net/http"
)

// ConflictMessage is the message of optimistic-concurrency conflicts (HTTP 409).
const ConflictMessage = "Conflict: refresh and try again"

// HTTPError is an error with an HTTP status and a client-safe message.
type HTTPError struct {
	Status  int
	Message string
}

// Error returns the client-safe message.
func (e *HTTPError) Error() string { return e.Message }

// New returns an *HTTPError with the given status and message.
func New(status int, message string) *HTTPError {
	return &HTTPError{Status: status, Message: message}
}

// BadRequest returns a 400 error.
func BadRequest(message string) *HTTPError { return New(http.StatusBadRequest, message) }

// NotFound returns a 404 error.
func NotFound(message string) *HTTPError { return New(http.StatusNotFound, message) }

// Conflict returns the 409 error of a stale or duplicate write.
func Conflict() *HTTPError { return New(http.StatusConflict, ConflictMessage) }

// As reports whether err is (or wraps) an *HTTPError and returns it.
func As(err error) (*HTTPError, bool) {
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		return httpErr, true
	}
	return nil, false
}

// IsConflict reports whether err is (or wraps) a 409 *HTTPError.
func IsConflict(err error) bool {
	e, ok := As(err)
	return ok && e.Status == http.StatusConflict
}
