// Package mail holds the RT-App mailers, ports of @gsalgadotoledo/rt-app-mail-local (LocalSMTP:
// development mail to a local inbox) and @gsalgadotoledo/rt-app-mail-smtp (SMTPMailer: production
// SMTP with TLS required). Both implement auth.Mailer and build messages with the rules of
// nodemailer, the TypeScript transport: address lists (Name <addr>, groups, IDN domains,
// SMTPUTF8), subjects that can never add a header, and text/HTML bodies. The contracts
// (rt-app/spec/contracts/mail-local.contract.yaml, mail-smtp.contract.yaml) pin the rules.
//
//	mailbox := &auth.LocalMailbox{}
//	local, err := mail.NewLocalSMTP(mail.WithPort(1025), mail.WithCapture(mailbox))
//	remote, err := mail.NewSMTP(os.Getenv("SMTP_URL"), os.Getenv("MAIL_FROM"))
package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"math"
	"os"
	"strconv"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/auth"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/web"
)

// Messages shared with TypeScript.
const (
	LocalFrom           = "RT-App <no-reply@rt-app.test>"
	LocalUnavailable    = "Local inbox is unavailable. Start it with npm run mail or restart npm run dev."
	DeliveryUnavailable = "Email delivery is temporarily unavailable"
)

// Errors with the TypeScript messages.
var (
	ErrProduction    = errors.New("Local SMTP is disabled in production")
	ErrInvalidPort   = errors.New("Invalid local SMTP port")
	ErrMailPorts     = errors.New("Local mail ports must be integers between 1024 and 65535")
	ErrSameMailPorts = errors.New("Local mail SMTP and UI ports must differ")
	ErrFromRequired  = errors.New("MAIL_FROM is required")
	ErrBadURL        = errors.New("SMTP_URL must be a URL like smtps://user:password@smtp.example.com:465")
	ErrBadScheme     = errors.New("SMTP_URL must use smtp:// or smtps://")
)

// CodeMessage is the sign-in code email every mailer sends.
func CodeMessage(email, code, purpose string) Message {
	return Message{
		To:      email,
		Subject: "RT-App: " + purpose,
		Text:    "Your code is " + code + ". It expires in 10 minutes. If you did not request it, ignore this email.",
	}
}

// --- LocalSMTP -------------------------------------------------------------------------------

// Capture records the codes a LocalSMTP delivered (auth.LocalMailbox).
type Capture interface {
	SendCode(ctx context.Context, email, code, purpose string) error
}

// LocalSMTP delivers development mail to an SMTP inbox on 127.0.0.1 (Mailpit, started by
// `rta mail`), never with TLS or authentication.
type LocalSMTP struct {
	port    int
	capture Capture
	now     func() time.Time
}

type localSettings struct {
	port    float64
	capture Capture
	env     func(string) string
	now     func() time.Time
}

// LocalOption configures a LocalSMTP.
type LocalOption func(*localSettings)

// WithPort sets the inbox port (default 1025): an integer in [1024, 65535].
func WithPort(port float64) LocalOption { return func(s *localSettings) { s.port = port } }

// WithCapture also records delivered codes (the GET /__dev/mailbox list).
func WithCapture(capture Capture) LocalOption {
	return func(s *localSettings) { s.capture = capture }
}

// WithEnv replaces os.Getenv (NODE_ENV=production refuses the mailer).
func WithEnv(env func(string) string) LocalOption { return func(s *localSettings) { s.env = env } }

// WithMessageClock sets the clock of the Date header (default time.Now).
func WithMessageClock(now func() time.Time) LocalOption {
	return func(s *localSettings) { s.now = now }
}

// NewLocalSMTP returns the development mailer. It fails with ErrProduction when NODE_ENV is
// "production" (checked first) and ErrInvalidPort when the port is not an integer in
// [1024, 65535].
func NewLocalSMTP(opts ...LocalOption) (*LocalSMTP, error) {
	s := localSettings{port: 1025, env: os.Getenv, now: time.Now}
	for _, opt := range opts {
		opt(&s)
	}
	if s.env("NODE_ENV") == "production" {
		return nil, ErrProduction
	}
	if math.IsNaN(s.port) || s.port != math.Trunc(s.port) || s.port < 1024 || s.port > 65535 {
		return nil, ErrInvalidPort
	}
	return &LocalSMTP{port: int(s.port), capture: s.capture, now: s.now}, nil
}

// Port is the inbox port.
func (l *LocalSMTP) Port() int { return l.port }

func (l *LocalSMTP) connection() Connection {
	return Connection{Host: "127.0.0.1", Port: l.port, IgnoreTLS: true, ConnectionTimeout: 3 * time.Second, SocketTimeout: 5 * time.Second}
}

// Send delivers the message from LocalFrom (unless message.From is set). Every failure is 503
// LocalUnavailable.
func (l *LocalSMTP) Send(ctx context.Context, message Message) error {
	if message.From == "" {
		message.From = LocalFrom
	}
	m, err := build(message, l.now())
	if err == nil {
		err = deliver(ctx, l.connection(), m)
	}
	if err != nil {
		return apperr.New(503, LocalUnavailable)
	}
	return nil
}

// SendCode delivers a code, then records it in the capture.
func (l *LocalSMTP) SendCode(ctx context.Context, email, code, purpose string) error {
	if err := l.Send(ctx, CodeMessage(email, code, purpose)); err != nil {
		return err
	}
	if l.capture != nil {
		return l.capture.SendCode(ctx, email, code, purpose)
	}
	return nil
}

var _ auth.Mailer = (*LocalSMTP)(nil)

// MailConfig are the ports of the local inbox.
type MailConfig struct {
	SMTPPort int    `json:"smtpPort"`
	UIPort   int    `json:"uiPort"`
	URL      string `json:"url"`
}

// LoadMailConfig reads RT_APP_MAIL_SMTP_PORT (1025) and RT_APP_MAIL_UI_PORT (8025) like
// JavaScript Number (" 2525 ", "0x401" and "2e3" are numbers, "" is 0); both must be integers in
// [1024, 65535] and differ. env returns a variable and whether it is set (os.LookupEnv).
func LoadMailConfig(env func(string) (string, bool)) (MailConfig, error) {
	if env == nil {
		env = os.LookupEnv
	}
	port := func(name string, fallback int) (int, error) {
		n := float64(fallback)
		if value, ok := env(name); ok {
			n = jsNumber(value)
		}
		if math.IsNaN(n) || n != math.Trunc(n) || n < 1024 || n > 65535 {
			return 0, ErrMailPorts
		}
		return int(n), nil
	}
	smtpPort, err := port("RT_APP_MAIL_SMTP_PORT", 1025)
	if err != nil {
		return MailConfig{}, err
	}
	uiPort, err := port("RT_APP_MAIL_UI_PORT", 8025)
	if err != nil {
		return MailConfig{}, err
	}
	if smtpPort == uiPort {
		return MailConfig{}, ErrSameMailPorts
	}
	return MailConfig{SMTPPort: smtpPort, UIPort: uiPort, URL: "http://127.0.0.1:" + strconv.Itoa(uiPort)}, nil
}

// jsNumber is JavaScript Number(text).
func jsNumber(text string) float64 {
	t := js.Trim(text)
	switch t {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[t[1]]
		if base != 0 {
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	if !decimalNumber(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// decimalNumber matches [+-]?(digits[.digits?]|.digits)([eE][+-]?digits)?
func decimalNumber(t string) bool {
	i := 0
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	digits := func() int {
		start := i
		for i < len(t) && t[i] >= '0' && t[i] <= '9' {
			i++
		}
		return i - start
	}
	whole, fraction := digits(), 0
	if i < len(t) && t[i] == '.' {
		i++
		fraction = digits()
	}
	if whole == 0 && fraction == 0 {
		return false
	}
	if i < len(t) && (t[i] == 'e' || t[i] == 'E') {
		i++
		if i < len(t) && (t[i] == '+' || t[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(t)
}

// Mailbox is what the GET /__dev/mailbox endpoint lists (auth.LocalMailbox).
type Mailbox interface {
	Messages() []auth.Message
}

// MailboxFeature is GET /__dev/mailbox: the captured codes, newest first. The TypeScript server
// answers it on its loopback-only local process and not on Lambda: mount it only in a local
// composition root.
func MailboxFeature(mailbox Mailbox) web.Feature {
	return web.Feature{ID: "mail-local", Endpoints: []web.Endpoint{{
		Method: "GET", Path: "/__dev/mailbox", Access: web.Guest, Resource: "mail.mailbox",
		Handle: func(*web.Context) (any, error) {
			messages := mailbox.Messages()
			if messages == nil {
				messages = []auth.Message{}
			}
			return messages, nil
		},
	}}}
}

// --- SMTPMailer ------------------------------------------------------------------------------

// Auth are SMTP credentials.
type Auth struct {
	User string `json:"user"`
	Pass string `json:"pass"`
}

// Options is what SMTPOptions returns (nodemailer's transport options in TypeScript).
type Options struct {
	Host              string `json:"host"`
	Port              int    `json:"port"`
	Secure            bool   `json:"secure"`
	RequireTLS        bool   `json:"requireTLS"`
	Auth              *Auth  `json:"auth,omitempty"`
	ConnectionTimeout int    `json:"connectionTimeout"`
	GreetingTimeout   int    `json:"greetingTimeout"`
	SocketTimeout     int    `json:"socketTimeout"`
	DisableFileAccess bool   `json:"disableFileAccess"`
	DisableURLAccess  bool   `json:"disableUrlAccess"`
}

// SMTPOptions parses SMTP_URL like JavaScript new URL: smtps://user:password@host:465 (implicit
// TLS) or smtp://user:password@host:587 (STARTTLS required). The host is kept as parsed.
func SMTPOptions(url string) (Options, error) {
	parsed, err := parseURL(url)
	if err != nil {
		return Options{}, ErrBadURL
	}
	if parsed.scheme != "smtp" && parsed.scheme != "smtps" {
		return Options{}, ErrBadScheme
	}
	secure := parsed.scheme == "smtps"
	o := Options{
		Host: parsed.hostname, Port: 587, Secure: secure, RequireTLS: !secure,
		ConnectionTimeout: 10000, GreetingTimeout: 10000, SocketTimeout: 20000,
		DisableFileAccess: true, DisableURLAccess: true,
	}
	if secure {
		o.Port = 465
	}
	if parsed.port != "" {
		o.Port, _ = strconv.Atoi(parsed.port)
	}
	if parsed.username != "" {
		user, err := decodeURIComponent(parsed.username)
		if err != nil {
			return Options{}, err
		}
		pass, err := decodeURIComponent(parsed.password)
		if err != nil {
			return Options{}, err
		}
		o.Auth = &Auth{User: user, Pass: pass}
	}
	return o, nil
}

// Transport is what an SMTPMailer hands messages to (inject a fake one in tests).
type Transport interface {
	SendMail(ctx context.Context, message Message) error
}

// ClientTransport is the real transport: it builds the message and delivers it over TLS.
type ClientTransport struct {
	Options   Options
	TLSConfig *tls.Config // nil: the system roots
}

// SendMail builds and delivers one message.
func (t ClientTransport) SendMail(ctx context.Context, message Message) error {
	m, err := build(message, time.Now())
	if err != nil {
		return err
	}
	c := Connection{
		Host: t.Options.Host, Port: t.Options.Port, Secure: t.Options.Secure, RequireTLS: t.Options.RequireTLS,
		ConnectionTimeout: time.Duration(t.Options.ConnectionTimeout) * time.Millisecond,
		SocketTimeout:     time.Duration(t.Options.SocketTimeout) * time.Millisecond,
	}
	if t.Options.Auth != nil {
		c.User, c.Password = t.Options.Auth.User, t.Options.Auth.Pass
	}
	c.TLSConfig = t.TLSConfig
	return deliver(ctx, c, m)
}

// SMTPMailer sends from MAIL_FROM; provider errors become 503 without details.
type SMTPMailer struct {
	from      string
	transport Transport
}

// NewSMTP returns a mailer; without a transport the URL is parsed now (never connecting).
func NewSMTP(url, from string, transport ...Transport) (*SMTPMailer, error) {
	if from == "" {
		return nil, ErrFromRequired
	}
	m := &SMTPMailer{from: from}
	if len(transport) > 0 && transport[0] != nil {
		m.transport = transport[0]
		return m, nil
	}
	options, err := SMTPOptions(url)
	if err != nil {
		return nil, err
	}
	m.transport = ClientTransport{Options: options}
	return m, nil
}

// Send hands {From: MAIL_FROM, ...message} to the transport; any failure is 503.
func (m *SMTPMailer) Send(ctx context.Context, message Message) error {
	message.From = m.from
	if err := m.transport.SendMail(ctx, message); err != nil {
		return apperr.New(503, DeliveryUnavailable)
	}
	return nil
}

// SendCode sends the sign-in code email.
func (m *SMTPMailer) SendCode(ctx context.Context, email, code, purpose string) error {
	return m.Send(ctx, CodeMessage(email, code, purpose))
}

var _ auth.Mailer = (*SMTPMailer)(nil)
