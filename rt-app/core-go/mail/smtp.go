package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"time"
)

// Connection is how to reach an SMTP server (the options nodemailer's SMTP transport uses).
//
// TLS rules: Secure starts with a TLS handshake (smtps); RequireTLS sends STARTTLS right after
// EHLO, even when the server does not offer it, and fails when it is refused, before any AUTH
// or MAIL; IgnoreTLS never upgrades; otherwise STARTTLS is used when offered.
type Connection struct {
	Host              string
	Port              int
	Secure            bool
	RequireTLS        bool
	IgnoreTLS         bool
	User, Password    string
	ConnectionTimeout time.Duration
	SocketTimeout     time.Duration
	TLSConfig         *tls.Config // nil: the system roots and the host name
}

// ErrRefused is returned when the server refuses the sender, every recipient or the message.
var ErrRefused = errors.New("smtp: refused")

func connectHost(host string) string {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return host[1 : len(host)-1]
	}
	if host == "" {
		return "localhost"
	}
	return host
}

func localName() string {
	name, err := os.Hostname()
	if err != nil || name == "" || nonASCII(name) || strings.ContainsAny(name, "\r\n") {
		return "localhost"
	}
	return name
}

func (c Connection) tlsConfig() *tls.Config {
	if c.TLSConfig != nil {
		return c.TLSConfig
	}
	return &tls.Config{ServerName: connectHost(c.Host), MinVersion: tls.VersionTLS12}
}

// deliver sends one built message.
func deliver(ctx context.Context, c Connection, m built) error {
	for _, a := range append([]string{m.sender}, m.recipients...) {
		if strings.ContainsAny(a, "\r\n") {
			return fmt.Errorf("smtp: invalid address")
		}
	}
	timeout := c.ConnectionTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	address := net.JoinHostPort(connectHost(c.Host), strconv.Itoa(c.Port))
	dialer := &net.Dialer{Timeout: timeout}
	var conn net.Conn
	var err error
	if c.Secure {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: c.tlsConfig()}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	socket := c.SocketTimeout
	if socket <= 0 {
		socket = 20 * time.Second
	}
	// The greeting and the whole dialogue share one deadline per step budget.
	_ = conn.SetDeadline(time.Now().Add(timeout + socket))
	client, err := smtp.NewClient(conn, connectHost(c.Host))
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Hello(localName()); err != nil {
		return err
	}
	if !c.Secure && (c.RequireTLS || !c.IgnoreTLS && hasExtension(client, "STARTTLS")) {
		// net/smtp sends STARTTLS without checking that the server offers it.
		if err := client.StartTLS(c.tlsConfig()); err != nil {
			return err
		}
	}
	if c.User != "" {
		if err := client.Auth(smtp.PlainAuth("", c.User, c.Password, connectHost(c.Host))); err != nil {
			return err
		}
	}
	params := ""
	if m.smtputf8 {
		if !hasExtension(client, "SMTPUTF8") {
			return fmt.Errorf("smtp: the server does not support SMTPUTF8")
		}
		params = " SMTPUTF8"
	}
	// Raw commands: net/smtp's Mail adds BODY=8BITMIME and SMTPUTF8 whenever offered.
	if err := command(client.Text, 250, "MAIL FROM:<%s>%s", m.sender, params); err != nil {
		return err
	}
	accepted := 0
	for _, r := range m.recipients {
		if err := command(client.Text, 25, "RCPT TO:<%s>", r); err == nil {
			accepted++
		} else if !isProtocolError(err) {
			return err
		}
	}
	if accepted == 0 {
		return ErrRefused
	}
	// Raw DATA: textproto's DotWriter turns "\r\r\n" into "\r\r\r\n"; nodemailer sends the bytes as
	// they are, only stuffing dots at line starts (after LF).
	if err := command(client.Text, 354, "DATA"); err != nil {
		return err
	}
	if _, err := client.Text.W.Write(dotStuff(m.data)); err != nil {
		return err
	}
	if _, err := client.Text.W.WriteString(".\r\n"); err != nil {
		return err
	}
	if err := client.Text.W.Flush(); err != nil {
		return err
	}
	if _, _, err := client.Text.ReadResponse(250); err != nil {
		return err
	}
	_ = client.Quit()
	return nil
}

// dotStuff doubles a "." that starts a line (at the start or after LF); data ends with LF.
func dotStuff(data []byte) []byte {
	out := make([]byte, 0, len(data)+8)
	for i, c := range data {
		if c == '.' && (i == 0 || data[i-1] == '\n') {
			out = append(out, '.')
		}
		out = append(out, c)
	}
	return out
}

func hasExtension(client *smtp.Client, name string) bool {
	ok, _ := client.Extension(name)
	return ok
}

// command sends one line and expects a reply code (2-digit codes accept any last digit).
func command(text *textproto.Conn, expect int, format string, args ...any) error {
	id, err := text.Cmd(format, args...)
	if err != nil {
		return err
	}
	text.StartResponse(id)
	defer text.EndResponse(id)
	_, _, err = text.ReadResponse(expect)
	return err
}

func isProtocolError(err error) bool {
	var protocol *textproto.Error
	return errors.As(err, &protocol)
}
