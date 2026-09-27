package main

// Subjects: mail-local, mail-smtp (mirrors hosts/node/mail.mjs; see the mail contracts). Mail goes
// to an in-process SMTP sink on 127.0.0.1 whose decoder is the same in every host:
// delivered() → [{mailFrom, rcptTo, smtputf8, headers, contentType, text, html}].

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/auth"
	"rt.local/core-go/conformance"
	"rt.local/core-go/mail"
)

func init() {
	register("mail-local", mailLocalSubject)
	register("mail-smtp", mailSMTPSubject)
}

var (
	sinkVerbs    = map[string]bool{"EHLO": true, "HELO": true, "STARTTLS": true, "AUTH": true, "MAIL": true, "RCPT": true, "DATA": true}
	hiddenFields = map[string]bool{"date": true, "message-id": true, "mime-version": true, "content-type": true, "content-transfer-encoding": true}
	encodedWord  = regexp.MustCompile(`=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=`)
	hexEscape    = regexp.MustCompile(`=([0-9A-Fa-f]{2})`)
	blank        = regexp.MustCompile(`^[ \t]*$`)
	notBase64    = regexp.MustCompile(`[^A-Za-z0-9+/]`)
)

// --- the sink's decoder (identical in every host) --------------------------------------------

// latin1 maps bytes to the runes U+0000–U+00FF (the sink's view of raw bytes).
func latin1(b []byte) string {
	runes := make([]rune, len(b))
	for i, c := range b {
		runes[i] = rune(c)
	}
	return string(runes)
}

// unlatin1 is the inverse of latin1.
func unlatin1(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		out = append(out, byte(r))
	}
	return out
}

func utf8Text(b []byte) string { return strings.ToValidUTF8(string(b), "\uFFFD") }

func qBytes(text string) []byte {
	return unlatin1(hexEscape.ReplaceAllStringFunc(text, func(m string) string {
		n, _ := strconv.ParseUint(m[1:], 16, 8)
		return string(rune(n))
	}))
}

func b64Bytes(text string) []byte {
	text = notBase64.ReplaceAllString(text, "")
	for len(text)%4 != 0 {
		text += "="
	}
	out, _ := base64.StdEncoding.DecodeString(text)
	return out
}

// decodeWords decodes RFC 2047 encoded words; whitespace between two adjacent encoded words is
// dropped and their bytes are joined (a character may be split across them).
func decodeWords(value string) string {
	var out strings.Builder
	var pending []byte
	havePending := false
	flush := func() {
		if havePending {
			out.WriteString(utf8Text(pending))
			pending, havePending = nil, false
		}
	}
	last := 0
	for _, m := range encodedWord.FindAllStringSubmatchIndex(value, -1) {
		between := value[last:m[0]]
		if !(havePending && blank.MatchString(between)) {
			flush()
			out.WriteString(between)
		}
		encoding, text := value[m[4]:m[5]], value[m[6]:m[7]]
		if strings.EqualFold(encoding, "B") {
			pending = append(pending, b64Bytes(text)...)
		} else {
			pending = append(pending, qBytes(strings.ReplaceAll(text, "_", " "))...)
		}
		havePending = true
		last = m[1]
	}
	flush()
	return out.String() + value[last:]
}

type field struct{ name, value string }

func headerFields(block string) []field {
	var fields []field
	for _, line := range strings.Split(block, "\r\n") {
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && len(fields) > 0 {
			fields[len(fields)-1].value += line
		} else if line != "" {
			if colon := strings.Index(line, ":"); colon > 0 {
				fields = append(fields, field{strings.ToLower(strings.TrimSpace(line[:colon])), line[colon+1:]})
			}
		}
	}
	for i := range fields {
		fields[i].value = strings.TrimPrefix(fields[i].value, " ")
	}
	return fields
}

func fieldValue(fields []field, name string) (string, bool) {
	for _, f := range fields {
		if f.name == name {
			return f.value, true
		}
	}
	return "", false
}

func decodeBody(body, encoding string) string {
	var data []byte
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "base64":
		data = b64Bytes(body)
	case "quoted-printable":
		data = qBytes(strings.ReplaceAll(body, "=\r\n", ""))
	default:
		data = unlatin1(body)
	}
	text := strings.ReplaceAll(utf8Text(data), "\r\n", "\n")
	return strings.TrimSuffix(text, "\n")
}

func mediaType(value string, present bool) string {
	if !present {
		value = "text/plain"
	}
	kind, _, _ := strings.Cut(value, ";")
	return strings.ToLower(strings.TrimSpace(kind))
}

var boundaryParam = regexp.MustCompile(`(?i);\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]*))`)

// decodeMessage turns a message as received (latin1 text of the DATA bytes, dot-unstuffed)
// into the decoded view.
func decodeMessage(data string) map[string]any {
	head, body, _ := strings.Cut(data, "\r\n\r\n")
	fields := headerFields(head)
	headers := map[string]any{}
	for _, f := range fields {
		if hiddenFields[f.name] {
			continue
		}
		value := decodeWords(utf8Text(unlatin1(f.value)))
		switch previous := headers[f.name].(type) {
		case nil:
			headers[f.name] = value
		case string:
			headers[f.name] = []string{previous, value}
		case []string:
			headers[f.name] = append(previous, value)
		}
	}
	contentTypeRaw, hasType := fieldValue(fields, "content-type")
	contentType := mediaType(contentTypeRaw, hasType)
	var text, html any
	if strings.HasPrefix(contentType, "multipart/") {
		boundary := ""
		if m := boundaryParam.FindStringSubmatch(contentTypeRaw); m != nil {
			boundary = m[1] + m[2]
		}
		for _, part := range strings.Split(body, "--"+boundary)[1:] {
			if strings.HasPrefix(part, "--") {
				break
			}
			content := strings.TrimSuffix(strings.TrimPrefix(part, "\r\n"), "\r\n")
			partHead, partBody, found := strings.Cut(content, "\r\n\r\n")
			if !found {
				partHead, partBody = content, ""
			}
			partFields := headerFields(partHead)
			encoding, _ := fieldValue(partFields, "content-transfer-encoding")
			kindRaw, hasKind := fieldValue(partFields, "content-type")
			decoded := decodeBody(partBody, encoding)
			switch mediaType(kindRaw, hasKind) {
			case "text/plain":
				text = decoded
			case "text/html":
				html = decoded
			}
		}
	} else {
		encoding, _ := fieldValue(fields, "content-transfer-encoding")
		decoded := decodeBody(body, encoding)
		if contentType == "text/html" {
			html = decoded
		} else {
			text = decoded
		}
	}
	return map[string]any{"headers": headers, "contentType": contentType, "text": text, "html": html}
}

func smtpPath(argument string) (string, []string) {
	text := strings.TrimSpace(argument)
	if !strings.HasPrefix(text, "<") {
		parts := strings.Split(text, " ")
		return parts[0], parts[1:]
	}
	end := strings.LastIndex(text, ">")
	if end < 0 {
		end = len(text)
	}
	rest := ""
	if end < len(text) {
		rest = text[end+1:]
	}
	return text[1:end], strings.Fields(rest)
}

// smtpSink is an SMTP sink on 127.0.0.1: starttls and auth only advertise; reject answers RCPT
// with 550.
type smtpSink struct {
	Starttls bool     `json:"starttls"`
	Auth     bool     `json:"auth"`
	Reject   []string `json:"reject"`

	listener net.Listener
	mu       sync.Mutex
	messages []map[string]any
	commands []string
	conns    map[net.Conn]bool
	closed   bool
}

func startSink(options json.RawMessage) (*smtpSink, error) {
	sink := &smtpSink{conns: map[net.Conn]bool{}}
	if len(options) > 0 && string(options) != "null" {
		if err := json.Unmarshal(options, sink); err != nil {
			return nil, fmt.Errorf("init.sink: %w", err)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	sink.listener = listener
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			sink.mu.Lock()
			sink.conns[conn] = true
			sink.mu.Unlock()
			go sink.session(conn)
		}
	}()
	return sink, nil
}

func (s *smtpSink) port() int { return s.listener.Addr().(*net.TCPAddr).Port }

func (s *smtpSink) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	_ = s.listener.Close()
	for conn := range s.conns {
		_ = conn.Close()
	}
}

func (s *smtpSink) delivered() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any{}, s.messages...)
}

func (s *smtpSink) verbs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.commands...)
}

func (s *smtpSink) session(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	reply := func(line string) { _, _ = conn.Write([]byte(line + "\r\n")) }
	type envelope struct {
		from     string
		to       []string
		smtputf8 bool
	}
	env := envelope{to: []string{}}
	reply("220 rt-app-sink ESMTP")
	for {
		raw, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		line := utf8Text(bytes.TrimRight(raw, "\r\n"))
		verb, _, _ := strings.Cut(line, " ")
		verb, _, _ = strings.Cut(verb, ":")
		verb = strings.ToUpper(verb)
		if sinkVerbs[verb] {
			s.mu.Lock()
			s.commands = append(s.commands, verb)
			s.mu.Unlock()
		}
		argument := line[strings.Index(line, ":")+1:]
		switch verb {
		case "EHLO":
			lines := []string{"rt-app-sink", "8BITMIME", "SMTPUTF8"}
			if s.Starttls {
				lines = append(lines, "STARTTLS")
			}
			if s.Auth {
				lines = append(lines, "AUTH PLAIN LOGIN")
			}
			for i, l := range lines {
				sep := "-"
				if i == len(lines)-1 {
					sep = " "
				}
				reply("250" + sep + l)
			}
		case "HELO":
			reply("250 rt-app-sink")
		case "MAIL":
			address, params := smtpPath(argument)
			env = envelope{from: address, to: []string{}, smtputf8: slices.ContainsFunc(params, func(p string) bool { return strings.EqualFold(p, "SMTPUTF8") })}
			reply("250 2.1.0 ok")
		case "RCPT":
			address, _ := smtpPath(argument)
			if slices.Contains(s.Reject, address) {
				reply("550 5.1.1 rejected")
			} else {
				env.to = append(env.to, address)
				reply("250 2.1.5 ok")
			}
		case "DATA":
			if len(env.to) == 0 {
				reply("554 5.5.1 no valid recipients")
				continue
			}
			reply("354 end with .")
			var lines [][]byte
			for {
				dataLine, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				if string(dataLine) == ".\r\n" {
					break
				}
				if bytes.HasPrefix(dataLine, []byte("..")) {
					dataLine = dataLine[1:]
				}
				lines = append(lines, dataLine)
			}
			message := decodeMessage(latin1(bytes.Join(lines, nil)))
			message["mailFrom"], message["rcptTo"], message["smtputf8"] = env.from, env.to, env.smtputf8
			s.mu.Lock()
			s.messages = append(s.messages, message)
			s.mu.Unlock()
			env = envelope{to: []string{}}
			reply("250 2.0.0 queued")
		case "QUIT":
			reply("221 2.0.0 bye")
			return
		case "RSET":
			env = envelope{to: []string{}}
			reply("250 ok")
		case "NOOP":
			reply("250 ok")
		case "STARTTLS":
			reply("454 4.7.0 TLS not available")
		case "AUTH":
			reply("535 5.7.8 authentication refused")
		default:
			reply("502 5.5.2 unknown command")
		}
	}
}

// --- subjects --------------------------------------------------------------------------------

func mailLocalSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Port        json.RawMessage `json:"port"`
		DefaultPort bool            `json:"defaultPort"`
		Capture     *bool           `json:"capture"`
		Now         *string         `json:"now"`
		NodeEnv     *string         `json:"nodeEnv"`
		Sink        json.RawMessage `json:"sink"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	sink, err := startSink(config.Sink)
	if err != nil {
		return conformance.Instance{}, err
	}
	var mu sync.Mutex
	now := time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC)
	if config.Now != nil {
		if now, err = time.Parse(time.RFC3339Nano, *config.Now); err != nil {
			sink.close()
			return conformance.Instance{}, err
		}
	}
	var mailbox *auth.LocalMailbox
	options := []mail.LocalOption{mail.WithEnv(func(name string) string {
		if name == "NODE_ENV" && config.NodeEnv != nil {
			return *config.NodeEnv
		}
		return ""
	})}
	if config.Capture == nil || *config.Capture {
		mailbox = &auth.LocalMailbox{Now: func() time.Time { mu.Lock(); defer mu.Unlock(); return now }}
		options = append(options, mail.WithCapture(mailbox))
	}
	switch {
	case config.DefaultPort:
	case len(config.Port) > 0 && string(config.Port) != "null":
		var port float64
		if json.Unmarshal(config.Port, &port) != nil {
			port = -1 // not a number: the constructor refuses it
		}
		options = append(options, mail.WithPort(port))
	default:
		options = append(options, mail.WithPort(float64(sink.port())))
	}
	mailer, err := mail.NewLocalSMTP(options...)
	if err != nil {
		sink.close()
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"send": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var message mail.Message
			if err := decodeArgs(args, &message); err != nil {
				return nil, err
			}
			return nil, mailer.Send(ctx, message)
		},
		"sendCode": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var email, code, purpose string
			if err := decodeArgs(args, &email, &code, &purpose); err != nil {
				return nil, err
			}
			return nil, mailer.SendCode(ctx, email, code, purpose)
		},
		"delivered": func(context.Context, []json.RawMessage) (any, error) { return sink.delivered(), nil },
		"commands":  func(context.Context, []json.RawMessage) (any, error) { return sink.verbs(), nil },
		"mailbox": func(context.Context, []json.RawMessage) (any, error) {
			if mailbox == nil {
				return nil, nil
			}
			messages := mailbox.Messages()
			if messages == nil {
				messages = []auth.Message{}
			}
			return messages, nil
		},
		"stopSink": func(context.Context, []json.RawMessage) (any, error) { sink.close(); return nil, nil },
		"setNow": func(_ context.Context, args []json.RawMessage) (any, error) {
			var iso string
			if err := decodeArgs(args, &iso); err != nil {
				return nil, err
			}
			moment, err := time.Parse(time.RFC3339Nano, iso)
			if err != nil {
				return nil, err
			}
			mu.Lock()
			now = moment
			mu.Unlock()
			return nil, nil
		},
		"mailConfig": func(_ context.Context, args []json.RawMessage) (any, error) {
			env := map[string]string{}
			if err := decodeArgs(args, &env); err != nil {
				return nil, err
			}
			return mail.LoadMailConfig(func(name string) (string, bool) { v, ok := env[name]; return v, ok })
		},
	}, Close: func() error { sink.close(); return nil }}, nil
}

type recordingTransport struct {
	mu   sync.Mutex
	sent []mail.Message
}

func (r *recordingTransport) SendMail(_ context.Context, message mail.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, message)
	return nil
}

type failingTransport struct{ url string }

func (f failingTransport) SendMail(context.Context, mail.Message) error {
	return errors.New("535 auth failed for " + f.url)
}

func mailSMTPSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		URL       string          `json:"url"`
		From      string          `json:"from"`
		Transport string          `json:"transport"`
		Sink      json.RawMessage `json:"sink"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	recorder := &recordingTransport{}
	var sink *smtpSink
	var transport mail.Transport
	switch config.Transport {
	case "", "fake":
		transport = recorder
	case "failing":
		transport = failingTransport{config.URL}
	case "sink":
		var err error
		if sink, err = startSink(config.Sink); err != nil {
			return conformance.Instance{}, err
		}
		config.URL = strings.ReplaceAll(config.URL, "{port}", strconv.Itoa(sink.port()))
	}
	var transports []mail.Transport
	if transport != nil {
		transports = append(transports, transport)
	}
	mailer, err := mail.NewSMTP(config.URL, config.From, transports...)
	if err != nil {
		if sink != nil {
			sink.close()
		}
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"send": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var message mail.Message
			if err := decodeArgs(args, &message); err != nil {
				return nil, err
			}
			return nil, mailer.Send(ctx, message)
		},
		"sendCode": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var email, code, purpose string
			if err := decodeArgs(args, &email, &code, &purpose); err != nil {
				return nil, err
			}
			return nil, mailer.SendCode(ctx, email, code, purpose)
		},
		"sent": func(context.Context, []json.RawMessage) (any, error) {
			recorder.mu.Lock()
			defer recorder.mu.Unlock()
			return append([]mail.Message{}, recorder.sent...), nil
		},
		"delivered": func(context.Context, []json.RawMessage) (any, error) {
			if sink == nil {
				return []any{}, nil
			}
			return sink.delivered(), nil
		},
		"commands": func(context.Context, []json.RawMessage) (any, error) {
			if sink == nil {
				return []string{}, nil
			}
			return sink.verbs(), nil
		},
		"smtpOptions": func(_ context.Context, args []json.RawMessage) (any, error) {
			var url *string
			if err := decodeArgs(args, &url); err != nil {
				return nil, err
			}
			if url == nil {
				return mail.SMTPOptions("undefined")
			}
			return mail.SMTPOptions(*url)
		},
	}, Close: func() error {
		if sink != nil {
			sink.close()
		}
		return nil
	}}, nil
}
