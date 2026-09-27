package mail

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
)

// Message is what a mailer sends. From is filled in by the mailer.
type Message struct {
	From    string `json:"from,omitempty"`
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
	HTML    string `json:"html,omitempty"`
}

// ErrNoRecipients is returned when the To field holds no address.
var ErrNoRecipients = errors.New("No recipients defined")

const headerWidth = 76

var (
	headerControls = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)
	newlines       = regexp.MustCompile(`\r?\n|\r`)
	plainBody      = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x{80}-\x{10ffff}]`)
	loneLF         = regexp.MustCompile(`(^|[^\r])\n`)
)

// textEncoding is nodemailer's _getTextEncoding: "Q" when Latin letters outnumber binary and
// non-ASCII UTF-16 units, else "B".
func textEncoding(value string) string {
	nonLatin, latin := 0, 0
	for _, r := range value {
		switch {
		case r <= 0x08 || r == 0x0b || r == 0x0c || r >= 0x0e && r <= 0x1f || r >= 0x80:
			nonLatin++
			if r > 0xffff {
				nonLatin++
			}
		case r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z':
			latin++
		}
	}
	if nonLatin < latin {
		return "Q"
	}
	return "B"
}

func qChar(r rune) string {
	var b strings.Builder
	for _, c := range []byte(string(r)) {
		switch {
		case c == ' ':
			b.WriteByte('_')
		case c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("!*+-/", c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "=%02X", c)
		}
	}
	return b.String()
}

// encodeWord returns RFC 2047 encoded words (UTF-8, Q or B) split on character boundaries.
func encodeWord(value, encoding string) string {
	if encoding == "" {
		encoding = textEncoding(value)
	}
	var chunks []string
	if encoding == "Q" {
		current := ""
		for _, r := range value {
			piece := qChar(r)
			if current != "" && len(current)+len(piece) > 40 {
				chunks = append(chunks, current)
				current = ""
			}
			current += piece
		}
		chunks = append(chunks, current)
	} else {
		var raw []byte
		for _, r := range value {
			encoded := []byte(string(r))
			if len(raw) > 0 && len(raw)+len(encoded) > 30 {
				chunks = append(chunks, base64.StdEncoding.EncodeToString(raw))
				raw = nil
			}
			raw = append(raw, encoded...)
		}
		chunks = append(chunks, base64.StdEncoding.EncodeToString(raw))
	}
	words := make([]string, len(chunks))
	for i, chunk := range chunks {
		words[i] = "=?UTF-8?" + encoding + "?" + chunk + "?="
	}
	return strings.Join(words, " ")
}

// encodeHeaderText is an unstructured header value (Subject): encoded when it has control
// characters, '"' or non-ASCII characters, so it can never add a header.
func encodeHeaderText(value string) string {
	if headerControls.MatchString(value) || strings.Contains(value, `"`) || nonASCII(value) {
		return encodeWord(value, "")
	}
	return value
}

// fold breaks a header line before spaces so lines stay within 76 characters when possible.
func fold(line string) string {
	if utf8.RuneCountInString(line) <= headerWidth {
		return line
	}
	var out []string
	for utf8.RuneCountInString(line) > headerWidth {
		limit := len(string([]rune(line)[:headerWidth+1]))
		cut := strings.LastIndexByte(line[:limit], ' ')
		if cut <= 0 {
			next := strings.IndexByte(line[limit:], ' ')
			if next < 0 {
				break
			}
			cut = limit + next
		}
		if strings.Trim(line[cut:], " ") == "" {
			break
		}
		out = append(out, line[:cut])
		line = line[cut:]
	}
	return strings.Join(append(out, line), "\r\n")
}

// crlf is nodemailer's line ending rule: every LF becomes CRLF, a lone CR stays.
func crlf(text string) string {
	// Two passes: a match consumes the character before "\n", so "\n\n" needs a second one.
	return loneLF.ReplaceAllString(loneLF.ReplaceAllString(text, "$1\r\n"), "$1\r\n")
}

// quotedPrintable is nodemailer's quoted-printable: CR and LF stay raw, a space or tab before a
// line break or at the end is encoded, lines are soft-wrapped at 76 characters.
func quotedPrintable(text string) string {
	data := []byte(text)
	var b strings.Builder
	line := 0
	for i, c := range data {
		if c == '\n' || c == '\r' {
			b.WriteByte(c)
			if c == '\n' {
				line = 0
			}
			continue
		}
		raw := c == '\t' || c >= 0x20 && c <= 0x7e && c != '='
		if (c == ' ' || c == '\t') && (i == len(data)-1 || data[i+1] == '\n' || data[i+1] == '\r') {
			raw = false
		}
		token := string(c)
		if !raw {
			token = fmt.Sprintf("=%02X", c)
		}
		if line+len(token) > 75 {
			b.WriteString("=\r\n")
			line = 0
		}
		b.WriteString(token)
		line += len(token)
	}
	return b.String()
}

func base64Lines(data []byte) string {
	text := base64.StdEncoding.EncodeToString(data)
	var lines []string
	for len(text) > 76 {
		lines = append(lines, text[:76])
		text = text[76:]
	}
	return strings.Join(append(lines, text), "\r\n")
}

func longLines(text string) bool {
	for _, line := range newlines.Split(text, -1) {
		if utf8.RuneCountInString(line) > 76 {
			return true
		}
	}
	return false
}

type header struct{ key, value string }

// part returns the headers and encoded body of one text part.
func part(contentType, content string) ([]header, string) {
	if content == "" {
		return []header{{"Content-Type", contentType}}, ""
	}
	body := crlf(content)
	encoding, encoded := "7bit", body
	switch {
	case !plainBody.MatchString(content) && !longLines(content):
	case textEncoding(content) == "Q":
		encoding, encoded = "quoted-printable", quotedPrintable(body)
	default:
		encoding, encoded = "base64", base64Lines([]byte(body))
	}
	return []header{{"Content-Type", contentType + "; charset=utf-8"}, {"Content-Transfer-Encoding", encoding}}, encoded
}

// built is a message ready for SMTP: the envelope and the DATA bytes (not dot-stuffed).
type built struct {
	sender     string
	recipients []string
	data       []byte
	smtputf8   bool
}

// build turns a message into its envelope and MIME text, like nodemailer's MailComposer.
func build(message Message, now time.Time) (built, error) {
	fromHeader, senders := addressList(message.From)
	toHeader, recipients := addressList(message.To)
	if len(recipients) == 0 {
		return built{}, ErrNoRecipients
	}
	sender := ""
	if len(senders) > 0 {
		sender = senders[0]
	}
	var headers []header
	if fromHeader != "" {
		headers = append(headers, header{"From", fromHeader})
	}
	if toHeader != "" {
		headers = append(headers, header{"To", toHeader})
	}
	if message.Subject != "" {
		if encoded := encodeHeaderText(newlines.ReplaceAllString(message.Subject, " ")); js.Trim(encoded) != "" {
			headers = append(headers, header{"Subject", encoded})
		}
	}
	domain := "localhost"
	if at := strings.LastIndexByte(sender, '@'); at >= 0 {
		domain = sender[at+1:]
	}
	headers = append(headers, header{"Message-ID", "<" + uuid.New() + "@" + domain + ">"})
	date := now.UTC().Format("Mon, 02 Jan 2006 15:04:05 -0700")
	var body string
	if message.Text != "" && message.HTML != "" {
		random := make([]byte, 8)
		_, _ = rand.Read(random)
		boundary := "--_RtApp-" + hex.EncodeToString(random) + "-Part_1"
		headers = append(headers, header{"Date", date}, header{"MIME-Version", "1.0"}, header{"Content-Type", `multipart/alternative; boundary="` + boundary + `"`})
		var b strings.Builder
		for _, p := range []struct{ kind, content string }{{"text/plain", message.Text}, {"text/html", message.HTML}} {
			partHeaders, partBody := part(p.kind, p.content)
			b.WriteString("--" + boundary + "\r\n")
			for _, h := range partHeaders {
				b.WriteString(h.key + ": " + h.value + "\r\n")
			}
			b.WriteString("\r\n" + partBody + "\r\n")
		}
		b.WriteString("--" + boundary + "--\r\n")
		body = b.String()
	} else {
		kind, content := "text/plain", message.Text
		if message.HTML != "" {
			kind, content = "text/html", message.HTML
		}
		partHeaders, partBody := part(kind, content)
		if len(partHeaders) > 1 {
			headers = append(headers, partHeaders[1])
		}
		headers = append(headers, header{"Date", date}, header{"MIME-Version", "1.0"}, partHeaders[0])
		body = partBody
	}
	lines := make([]string, len(headers))
	for i, h := range headers {
		lines[i] = fold(h.key + ": " + h.value)
	}
	data := []byte(strings.Join(lines, "\r\n") + "\r\n\r\n" + body)
	// nodemailer's LastNewline: the message ends with a line break; a final CR only gets its LF.
	switch {
	case strings.HasSuffix(string(data), "\n"):
	case strings.HasSuffix(string(data), "\r"):
		data = append(data, '\n')
	default:
		data = append(data, '\r', '\n')
	}
	return built{sender: sender, recipients: recipients, data: data, smtputf8: needsSMTPUTF8(append([]string{sender}, recipients...)...)}, nil
}
