// Package sms is the Observer output that publishes one short text per event through SNS
// (TypeScript SmsOutput).
package sms

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"rt.local/core-go/observer"
)

// ErrPhone is returned by New for numbers that are not E.164.
var ErrPhone = errors.New("Observer SMS requires E.164 phone number")

var e164 = regexp.MustCompile(`^\+[1-9][0-9]{7,14}$`)

// Client publishes one SMS. Adapt *sns.Client (aws-sdk-go-v2/service/sns) with a small function
// calling Publish(PhoneNumber, Message); tests use fakes.
type Client interface {
	Publish(ctx context.Context, phone, message string) error
}

// ClientFunc adapts a function to Client.
type ClientFunc func(ctx context.Context, phone, message string) error

// Publish calls f.
func (f ClientFunc) Publish(ctx context.Context, phone, message string) error {
	return f(ctx, phone, message)
}

// Output sends "<LEVEL> <source>: <message>" cut to 140 UTF-16 units.
type Output struct {
	phone  string
	client Client
}

// New checks the number (^\+[1-9]\d{7,14}$, ASCII digits).
func New(phone string, client Client) (*Output, error) {
	if !e164.MatchString(phone) {
		return nil, ErrPhone
	}
	return &Output{phone: phone, client: client}, nil
}

// ID is "sms".
func (o *Output) ID() string { return "sms" }

// Write publishes one message; client errors are returned unchanged.
func (o *Output) Write(ctx context.Context, event observer.Event) error {
	if o.client == nil {
		return errors.New("Observer SMS has no SNS client")
	}
	return o.client.Publish(ctx, o.phone, Cut(strings.ToUpper(event.Level)+" "+event.Source+": "+event.Message, 140))
}

// Cut is text.slice(0, n) in UTF-16 units; a surrogate pair the cut would split is dropped.
func Cut(text string, n int) string {
	units := 0
	for i, r := range text {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > n {
			return text[:i]
		}
		units += size
	}
	return text
}
