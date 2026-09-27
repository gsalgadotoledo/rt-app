package observer_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rt.local/core-go/observer"
	"rt.local/core-go/observer/console"
	"rt.local/core-go/observer/email"
	"rt.local/core-go/observer/slack"
	"rt.local/core-go/observer/sms"
	"rt.local/core-go/observer/webhook"
)

func sample() observer.Event {
	return observer.Event{Category: "payments", ID: "e1", At: "2026-03-04T05:06:07.890Z", Level: "error", Kind: "log", Source: "app", Message: "Declined", Data: map[string]any{"n": 1.0, "x": 1e-7, "html": "<&>"}, RequestID: "r1"}
}

type transport struct {
	status   int
	requests []observer.OutputRequest
}

func (t *transport) send(_ context.Context, r observer.OutputRequest) (int, error) {
	t.requests = append(t.requests, r)
	return t.status, nil
}

func TestConsole(t *testing.T) {
	var lines []string
	out := console.New(func(level, line string) { lines = append(lines, level+" "+line) })
	_ = out.Write(context.Background(), sample())
	want := `error {"category":"payments","id":"e1","at":"2026-03-04T05:06:07.890Z","level":"error","kind":"log","source":"app","message":"Declined","data":{"html":"<&>","n":1,"x":1e-7},"requestId":"r1"}`
	if out.ID() != "console" || len(lines) != 1 || lines[0] != want {
		t.Fatalf("lines: %q", lines)
	}
	var stdout, stderr strings.Builder
	console.Writers(&stdout, &stderr)("warn", "w")
	console.Writers(&stdout, &stderr)("info", "i")
	if stdout.String() != "i\n" || stderr.String() != "w\n" {
		t.Fatalf("streams: %q %q", stdout.String(), stderr.String())
	}
}

func TestWebhookAndPostOutput(t *testing.T) {
	fake := &transport{status: 200}
	out, err := webhook.New("audit", "https://LOGS.test:443/in", map[string]string{"X-Key": "k"}, fake.send)
	if err != nil {
		t.Fatal(err)
	}
	if err := out.Write(context.Background(), sample()); err != nil || fake.requests[0].URL != "https://logs.test/in" || fake.requests[0].Headers["Content-Type"] != "application/json" || fake.requests[0].Headers["X-Key"] != "k" {
		t.Fatalf("request: %+v %v", fake.requests, err)
	}
	if _, err := webhook.New("x", "http://logs.test", nil, fake.send); err != webhook.ErrNotHTTPS {
		t.Fatalf("https: %v", err)
	}
	if err := observer.PostOutput(context.Background(), "https://u:p@logs.test", "{}", nil, fake.send); err != observer.ErrCredentials {
		t.Fatalf("credentials: %v", err)
	}
	if err := observer.PostOutput(context.Background(), "https://logs.test", "{}", nil, (&transport{status: 302}).send); err == nil || err.Error() != "Observer destination returned HTTP 302" {
		t.Fatalf("redirect: %v", err)
	}
	if len(fake.requests) != 1 {
		t.Fatalf("no request without https: %d", len(fake.requests))
	}
}

func TestSlack(t *testing.T) {
	fake := &transport{status: 200}
	out, err := slack.New("https://hooks.slack.com/services/x", fake.send)
	if err != nil {
		t.Fatal(err)
	}
	_ = out.Write(context.Background(), sample())
	if fake.requests[0].Body != `{"text":"[error] payments: Declined\nRequest: r1","mrkdwn":false}` {
		t.Fatalf("body: %s", fake.requests[0].Body)
	}
	for _, url := range []string{"https://hooks.slack.com./services/x", "https://evil.test/services/x", "https://hooks.slack.com/services"} {
		if _, err := slack.New(url, fake.send); err != slack.ErrInvalidWebhook {
			t.Errorf("%s: %v", url, err)
		}
	}
}

func TestEmailAndSMS(t *testing.T) {
	var inputs []email.Input
	out, err := email.New("a@x.test", "b@x.test", email.ClientFunc(func(_ context.Context, input email.Input) error {
		inputs = append(inputs, input)
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	_ = out.Write(context.Background(), sample())
	if inputs[0].Content.Simple.Subject.Data != "[error] app" || !strings.HasPrefix(inputs[0].Content.Simple.Body.Text.Data, "{\n  \"category\": \"payments\",") {
		t.Fatalf("input: %+v", inputs)
	}
	if _, err := email.New("a", "b@x.test", nil); err != email.ErrAddresses {
		t.Fatalf("addresses: %v", err)
	}
	var mails []email.Mail
	local, err := email.NewLocal("a", "b", 1024, email.WithProduction(false), email.WithSender(func(_ context.Context, m email.Mail) error {
		mails = append(mails, m)
		return nil
	}))
	if err != nil || local.Write(context.Background(), sample()) != nil || mails[0].Subject != "[error] app" {
		t.Fatalf("local: %v %+v", err, mails)
	}
	if _, err := email.NewLocal("a", "b", 1, email.WithProduction(true)); err != email.ErrProduction {
		t.Fatalf("production: %v", err)
	}
	if _, err := email.NewLocal("a", "b", 1023, email.WithProduction(false)); err != email.ErrPort {
		t.Fatalf("port: %v", err)
	}
	var messages []string
	text, err := sms.New("+15555550123", sms.ClientFunc(func(_ context.Context, _, message string) error {
		messages = append(messages, message)
		return errors.New("SNS down")
	}))
	if err != nil {
		t.Fatal(err)
	}
	event := sample()
	event.Message = strings.Repeat("x", 200)
	if err := text.Write(context.Background(), event); err == nil || len(messages[0]) != 140 || !strings.HasPrefix(messages[0], "ERROR app: ") {
		t.Fatalf("sms: %v %q", err, messages)
	}
	if _, err := sms.New("+1555555012\n", nil); err != sms.ErrPhone {
		t.Fatalf("phone: %v", err)
	}
	if got := sms.Cut("ab\U0001F600", 3); got != "ab" {
		t.Fatalf("a split pair is dropped: %q", got)
	}
}
