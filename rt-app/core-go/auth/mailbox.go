package auth

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// Mailer delivers the codes of email sign-in, password reset and email change.
type Mailer interface {
	SendCode(ctx context.Context, email, code, purpose string) error
}

// Message is one code captured by a LocalMailbox.
type Message struct {
	Email   string    `json:"email"`
	Code    string    `json:"code"`
	Purpose string    `json:"purpose"`
	At      time.Time `json:"at"`
}

// MarshalJSON writes At like JavaScript toISOString (UTC, milliseconds: 2026-01-02T03:04:05.678Z),
// the format of GET /__dev/mailbox in every language.
func (m Message) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Email   string `json:"email"`
		Code    string `json:"code"`
		Purpose string `json:"purpose"`
		At      string `json:"at"`
	}{m.Email, m.Code, m.Purpose, m.At.UTC().Format("2006-01-02T15:04:05.000Z")})
}

// mailboxSize is how many messages a LocalMailbox keeps.
const mailboxSize = 30

// LocalMailbox is a Mailer for local development and tests: it keeps the last 30 messages,
// newest first, instead of sending them. It is safe for concurrent use.
type LocalMailbox struct {
	// Now stamps messages (time.Now when nil).
	Now func() time.Time

	mu       sync.Mutex
	messages []Message
}

// SendCode records the message.
func (m *LocalMailbox) SendCode(_ context.Context, email, code, purpose string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now
	if m.Now != nil {
		now = m.Now
	}
	m.messages = append([]Message{{Email: email, Code: code, Purpose: purpose, At: now().UTC()}}, m.messages...)
	m.messages = m.messages[:min(len(m.messages), mailboxSize)]
	return nil
}

// Messages returns a copy of the captured messages, newest first.
func (m *LocalMailbox) Messages() []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Message(nil), m.messages...)
}
