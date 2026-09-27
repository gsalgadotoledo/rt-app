// Package email holds the Observer email outputs: SES v2 (New) and the local mail viewer
// (NewLocal). Both send the subject "[<level>] <source>" and event.JSON(2) as text.
package email

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"strings"
	"time"

	"rt.local/core-go/observer"
)

// Errors of the constructors.
var (
	ErrAddresses  = errors.New("Observer email requires valid from/to addresses")
	ErrProduction = errors.New("Local observer email is disabled in production")
	ErrPort       = errors.New("Invalid local SMTP port")
)

// Input is the SES v2 SendEmail request (the field names of the API).
type Input struct {
	FromEmailAddress string      `json:"FromEmailAddress"`
	Destination      Destination `json:"Destination"`
	Content          Content     `json:"Content"`
}

// Destination lists the recipients.
type Destination struct {
	ToAddresses []string `json:"ToAddresses"`
}

// Content is a simple (subject and text) message.
type Content struct {
	Simple Simple `json:"Simple"`
}

// Simple is the subject and body of a message.
type Simple struct {
	Subject Text `json:"Subject"`
	Body    Body `json:"Body"`
}

// Body holds the text part.
type Body struct {
	Text Text `json:"Text"`
}

// Text is one SES text value.
type Text struct {
	Data string `json:"Data"`
}

// Client sends one SES v2 email. Adapt *sesv2.Client (aws-sdk-go-v2/service/sesv2) with a small
// function that maps Input to sesv2.SendEmailInput; tests use fakes.
type Client interface {
	SendEmail(ctx context.Context, input Input) error
}

// ClientFunc adapts a function to Client.
type ClientFunc func(ctx context.Context, input Input) error

// SendEmail calls f.
func (f ClientFunc) SendEmail(ctx context.Context, input Input) error { return f(ctx, input) }

func subject(event observer.Event) string { return "[" + event.Level + "] " + event.Source }

// Output sends one SES email per event.
type Output struct {
	from, to string
	client   Client
}

// New returns the SES output; both addresses must contain "@".
func New(from, to string, client Client) (*Output, error) {
	if !strings.Contains(from, "@") || !strings.Contains(to, "@") {
		return nil, ErrAddresses
	}
	return &Output{from: from, to: to, client: client}, nil
}

// ID is "email".
func (o *Output) ID() string { return "email" }

// Write sends one message; client errors are returned unchanged.
func (o *Output) Write(ctx context.Context, event observer.Event) error {
	if o.client == nil {
		return errors.New("Observer email has no SES client")
	}
	return o.client.SendEmail(ctx, Input{
		FromEmailAddress: o.from,
		Destination:      Destination{ToAddresses: []string{o.to}},
		Content:          Content{Simple: Simple{Subject: Text{Data: subject(event)}, Body: Body{Text: Text{Data: event.JSON(2)}}}},
	})
}

// Mail is one message for the local mail viewer.
type Mail struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}

// Sender delivers one local message.
type Sender func(ctx context.Context, mail Mail) error

// LocalOption configures NewLocal.
type LocalOption func(*Local)

// WithSender replaces the SMTP sender (tests).
func WithSender(send Sender) LocalOption { return func(l *Local) { l.send = send } }

// WithProduction overrides the production check (NODE_ENV=production by default).
func WithProduction(production bool) LocalOption {
	return func(l *Local) { l.production = production }
}

// Local sends to the local mail viewer over plain SMTP on 127.0.0.1 (development only).
type Local struct {
	from, to   string
	send       Sender
	production bool
}

// NewLocal refuses production first, then ports outside 1024-65535. Addresses are not validated.
func NewLocal(from, to string, port int, options ...LocalOption) (*Local, error) {
	l := &Local{from: from, to: to, production: os.Getenv("NODE_ENV") == "production"}
	for _, option := range options {
		option(l)
	}
	if l.production {
		return nil, ErrProduction
	}
	if port < 1024 || port > 65535 {
		return nil, ErrPort
	}
	if l.send == nil {
		l.send = SMTPSender(port)
	}
	return l, nil
}

// ID is "email".
func (l *Local) ID() string { return "email" }

// Write sends one message; sender errors are returned unchanged.
func (l *Local) Write(ctx context.Context, event observer.Event) error {
	return l.send(ctx, Mail{From: l.from, To: l.to, Subject: subject(event), Text: event.JSON(2)})
}

// SMTPSender sends plain SMTP to 127.0.0.1:port with 1-second timeouts; never an arbitrary server.
func SMTPSender(port int) Sender {
	return func(ctx context.Context, mail Mail) error {
		dialer := net.Dialer{Timeout: time.Second}
		conn, err := dialer.DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return err
		}
		_ = conn.SetDeadline(time.Now().Add(time.Second))
		client, err := smtp.NewClient(conn, "127.0.0.1")
		if err != nil {
			_ = conn.Close()
			return err
		}
		defer client.Close()
		if err := client.Mail(mail.From); err != nil {
			return err
		}
		if err := client.Rcpt(mail.To); err != nil {
			return err
		}
		w, err := client.Data()
		if err != nil {
			return err
		}
		message := "From: " + mail.From + "\r\nTo: " + mail.To + "\r\nSubject: " + mail.Subject +
			"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + strings.ReplaceAll(mail.Text, "\n", "\r\n") + "\r\n"
		if _, err := w.Write([]byte(message)); err != nil {
			return err
		}
		if err := w.Close(); err != nil {
			return err
		}
		return client.Quit()
	}
}
