package mail

// Address lists the way nodemailer 10 reads them (the TypeScript mailers delegate to it):
// parseAddresses is nodemailer's addressparser and normalizeAddress/convertAddresses its MimeNode
// rules for the To header and the SMTP envelope. Text is handled as runes; JavaScript uses UTF-16
// units, but every rule only looks at ASCII characters and whitespace, so results are the same.

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"rt.local/core-go/internal/js"
)

// address is one parsed entry: a mailbox (Address, Name) or a group (Name, Group).
type address struct {
	Name    string
	Address string
	IsGroup bool
	Group   []*address
}

const maxNestedGroupDepth = 50

var (
	jsSpaceClass   = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`
	hasWhitespace  = regexp.MustCompile(`[` + jsSpaceClass + `]`)
	quotedLocal    = regexp.MustCompile(`^("(?:[^"\\]|\\[\s\S])*"@[^` + jsSpaceClass + `]+)(?:[` + jsSpaceClass + `]+([\s\S]+))?$`)
	addrSpec       = regexp.MustCompile(`^[^@` + jsSpaceClass + `]+@[^@` + jsSpaceClass + `]+$`)
	looseAddrSpec  = regexp.MustCompile(`^[^@` + jsSpaceClass + `]+@[^` + jsSpaceClass + `]+$`)
	plainLocal     = regexp.MustCompile(`^[^` + jsSpaceClass + `"(),:;<>@\[\\\]]+$`)
	quotedString   = regexp.MustCompile(`^"(?:[^"\\]|\\[\s\S])*"$`)
	splitSpace     = regexp.MustCompile(`[` + jsSpaceClass + `]+`)
	addressAngle   = regexp.MustCompile(`^[^<]*<[` + jsSpaceClass + `]*`)
	dotAtom        = regexp.MustCompile("^[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\x{80}-\\x{10ffff}]+(?:\\.[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\x{80}-\\x{10ffff}]+)*$")
	plainAddress   = regexp.MustCompile(`^[^` + jsSpaceClass + `"(),:;<>@\[\\\]]+@[^` + jsSpaceClass + `"(),:;<>@\[\\\]]+$`)
	controlsAngles = regexp.MustCompile(`[\x00-\x1f\x7f<>]+`)
	wordName       = regexp.MustCompile(`^[A-Za-z0-9_ ]*$`)
	printable      = regexp.MustCompile(`^[\x20-\x7e]*$`)
	quoteSpecials  = regexp.MustCompile(`["\\]`)
)

func nonASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return true
		}
	}
	return false
}

// quoteString is nodemailer's quoteString: "…" with '"' and '\' escaped.
func quoteString(value string) string {
	return `"` + quoteSpecials.ReplaceAllString(value, `\$0`) + `"`
}

// --- addressparser ---------------------------------------------------------------------------

type token struct {
	operator bool
	value    string
	noBreak  bool
}

var operators = map[rune]rune{'"': '"', '(': ')', '<': '>', ',': 0, ':': ';', ';': 0}

func tokenize(text string) []*token {
	chars := []rune(text)
	var tokens []*token
	var node *token
	var expecting rune = -1
	escaped, inDomainLiteral := false, false
	for i, chr := range chars {
		next := rune(-1)
		if i < len(chars)-1 {
			next = chars[i+1]
		}
		if !escaped && expecting == -1 {
			if !inDomainLiteral && chr == '[' {
				inDomainLiteral = true
			} else if inDomainLiteral && (chr == ']' || chr == ',' || chr == ';') {
				inDomainLiteral = false
			}
		}
		switch {
		case escaped:
		case expecting != -1 && chr == expecting:
			op := &token{operator: true, value: string(chr)}
			if next != -1 && !strings.ContainsRune(" \t\r\n,;", next) {
				op.noBreak = true
			}
			tokens = append(tokens, op)
			node, expecting, escaped = nil, -1, false
			continue
		case expecting == -1 && !inDomainLiteral && isOperator(chr):
			tokens = append(tokens, &token{operator: true, value: string(chr)})
			node, escaped = nil, false
			expecting = operators[chr]
			if expecting == 0 {
				expecting = -1
			}
			continue
		case (expecting == '"' || expecting == '\'') && chr == '\\':
			escaped = true
			continue
		}
		if node == nil {
			node = &token{}
			tokens = append(tokens, node)
		}
		if chr == '\n' {
			chr = ' '
		}
		if chr >= 0x21 || chr == ' ' || chr == '\t' {
			node.value += string(chr)
		}
		escaped = false
	}
	out := tokens[:0]
	for _, t := range tokens {
		t.value = js.Trim(t.value)
		if t.value != "" {
			out = append(out, t)
		}
	}
	return out
}

func isOperator(r rune) bool { _, ok := operators[r]; return ok }

func isWord(r rune) bool {
	return r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r == '_'
}

// boundary is the ASCII \b between chars[at-1] and chars[at].
func boundary(chars []rune, at int) bool {
	before := at > 0 && at <= len(chars) && isWord(chars[at-1])
	after := at >= 0 && at < len(chars) && isWord(chars[at])
	return before != after
}

func indexOfAt(chars []rune, from, to int) int {
	for i := from; i < to; i++ {
		if chars[i] == '@' {
			return i
		}
	}
	return -1
}

// looseAddressStart is where /\s*\b[^@\s]+@[^\s]+\b\s*/y can match in free text, or -1.
func looseAddressStart(chars []rune) int {
	length, pos := len(chars), 0
	for pos < length {
		for pos < length && js.IsSpace(chars[pos]) {
			pos++
		}
		if pos >= length {
			break
		}
		runStart, runEnd := pos, pos
		for runEnd < length && !js.IsSpace(chars[runEnd]) {
			runEnd++
		}
		if at := indexOfAt(chars, runStart, runEnd); at >= 0 {
			lastBoundary := -1
			for k := runEnd; k > runStart; k-- {
				if boundary(chars, k) {
					lastBoundary = k
					break
				}
			}
			atomStart := runStart
			for lastBoundary >= 0 && at >= 0 {
				if at > atomStart && runEnd > at+1 && lastBoundary > at+1 {
					for start := atomStart; start < at; start++ {
						if boundary(chars, start) {
							if start > runStart {
								return start
							}
							padded := runStart
							for padded > 0 && js.IsSpace(chars[padded-1]) {
								padded--
							}
							return padded
						}
					}
				}
				atomStart = at + 1
				at = indexOfAt(chars, atomStart, runEnd)
			}
		}
		pos = runEnd
	}
	return -1
}

// looseTextMatch is /\s*\b[^@\s]+@[^\s]+\b\s*/y at `at` (JavaScript backtracking, ASCII \b):
// the end of the match, or -1.
func looseTextMatch(chars []rune, at int) int {
	p := at
	for p < len(chars) && js.IsSpace(chars[p]) {
		p++
	}
	if !boundary(chars, p) {
		return -1
	}
	q := p
	for q < len(chars) && chars[q] != '@' && !js.IsSpace(chars[q]) {
		q++
	}
	if q == p || q >= len(chars) || chars[q] != '@' {
		return -1
	}
	end := q + 1
	for end < len(chars) && !js.IsSpace(chars[end]) {
		end++
	}
	for end > q+1 && !boundary(chars, end) {
		end--
	}
	if end <= q+1 || !boundary(chars, end) {
		return -1
	}
	for end < len(chars) && js.IsSpace(chars[end]) {
		end++
	}
	return end
}

func quoteLocalPart(addr string) string {
	lastAt := strings.LastIndex(addr, "@")
	if lastAt < 0 {
		return addr
	}
	user := addr[:lastAt]
	if plainLocal.MatchString(user) || quotedString.MatchString(user) {
		return addr
	}
	return quoteString(user) + "@" + addr[lastAt+1:]
}

func recoverAddrSpec(addr, text *string) {
	if !hasWhitespace.MatchString(*addr) {
		return
	}
	var found string
	var rest []string
	if m := quotedLocal.FindStringSubmatch(*addr); m != nil {
		if m[2] == "" {
			return
		}
		found, rest = m[1], []string{m[2]}
	} else {
		if strings.Contains(*addr, `"`) {
			return
		}
		parts := splitSpace.Split(*addr, -1)
		index := slices.IndexFunc(parts, addrSpec.MatchString)
		if index < 0 {
			index = slices.IndexFunc(parts, looseAddrSpec.MatchString)
		}
		if index < 0 {
			return
		}
		found = parts[index]
		rest = append(parts[:index:index], parts[index+1:]...)
	}
	*addr = found
	var kept []string
	for _, part := range append([]string{*text}, rest...) {
		if part != "" {
			kept = append(kept, part)
		}
	}
	*text = strings.Join(kept, " ")
}

func handleAddress(tokens []*token, depth int) []*address {
	isGroup, insideQuotes := false, false
	state := "text"
	data := map[string][]string{}
	var textWasQuoted []bool
	lastChars := map[string]string{}
	for i, t := range tokens {
		var prev, prevPrev *token
		if i > 0 {
			prev = tokens[i-1]
		}
		if i > 1 {
			prevPrev = tokens[i-2]
		}
		if t.operator {
			switch t.value {
			case "<":
				state, insideQuotes = "address", false
			case "(":
				state, insideQuotes = "comment", false
			case ":":
				state, isGroup, insideQuotes = "group", true, false
			case `"`:
				insideQuotes = !insideQuotes
				state = "text"
			default:
				state, insideQuotes = "text", false
			}
			continue
		}
		if t.value == "" {
			continue
		}
		opensAfterEmptyQuoted := prev != nil && prev.operator && prev.value == `"` && prev.noBreak && prevPrev != nil && prevPrev.operator && prevPrev.value == `"`
		if state == "address" {
			t.value = addressAngle.ReplaceAllString(t.value, "")
		}
		parts := data[state]
		joins := prev != nil && prev.noBreak && len(parts) > 0 && (prev.value != ")" || lastChars[state] == "@" || strings.HasPrefix(t.value, "@"))
		if joins {
			parts[len(parts)-1] += t.value
			if t.value != "" {
				r, _ := utf8.DecodeLastRuneInString(t.value)
				lastChars[state] = string(r)
			}
			if state == "text" && insideQuotes {
				textWasQuoted[len(textWasQuoted)-1] = true
			}
		} else {
			data[state] = append(parts, t.value)
			lastChars[state] = ""
			if t.value != "" {
				r, _ := utf8.DecodeLastRuneInString(t.value)
				lastChars[state] = string(r)
			}
			if state == "text" {
				textWasQuoted = append(textWasQuoted, insideQuotes || opensAfterEmptyQuoted)
			}
		}
	}
	if len(data["text"]) == 0 && len(data["comment"]) > 0 {
		data["text"], data["comment"] = data["comment"], nil
	}
	quotedAt := func(i int) bool { return i < len(textWasQuoted) && textWasQuoted[i] }
	if isGroup {
		group := &address{Name: strings.Join(data["text"], " "), IsGroup: true, Group: []*address{}}
		if len(data["group"]) > 0 {
			for _, member := range parseAddresses(strings.Join(data["group"], ","), depth+1) {
				if member.IsGroup {
					group.Group = append(group.Group, member.Group...)
				} else {
					group.Group = append(group.Group, member)
				}
			}
		}
		return []*address{group}
	}
	text, addr := data["text"], data["address"]
	if len(addr) == 0 && len(text) > 0 {
		for i := len(text) - 1; i >= 0; i-- {
			if !quotedAt(i) && addrSpec.MatchString(text[i]) {
				addr = []string{text[i]}
				text = append(text[:i:i], text[i+1:]...)
				if i < len(textWasQuoted) {
					textWasQuoted = append(textWasQuoted[:i:i], textWasQuoted[i+1:]...)
				}
				break
			}
		}
		if len(addr) == 0 {
			for i := len(text) - 1; i >= 0; i-- {
				if quotedAt(i) {
					continue
				}
				chars := []rune(text[i])
				remainder, extracted := text[i], false
				if at := looseAddressStart(chars); at >= 0 {
					if end := looseTextMatch(chars, at); end >= 0 {
						addr = []string{js.Trim(string(chars[at:end]))}
						extracted = true
						remainder = string(chars[:at]) + " " + string(chars[end:])
					}
				}
				text[i] = js.Trim(remainder)
				if extracted {
					break
				}
			}
		}
	}
	if len(text) == 0 && len(data["comment"]) > 0 {
		text = data["comment"]
	}
	if len(addr) > 1 {
		text = append(slices.Clone(text), addr[1:]...)
		addr = addr[:1]
	}
	fromQuoted := len(addr) == 0 && slices.Contains(textWasQuoted, true)
	joinedText, joinedAddr := strings.Join(text, " "), strings.Join(addr, " ")
	if fromQuoted && joinedText != "" {
		joinedAddr, joinedText = quoteLocalPart(joinedText), ""
	}
	recoverAddrSpec(&joinedAddr, &joinedText)
	out := &address{Address: firstNonEmpty(joinedAddr, joinedText), Name: firstNonEmpty(joinedText, joinedAddr)}
	if out.Address == out.Name {
		if strings.Contains(out.Address, "@") {
			out.Name = ""
		} else {
			out.Address = ""
		}
	}
	return []*address{out}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// parseAddresses is nodemailer's addressparser.
func parseAddresses(text string, depth int) []*address {
	if depth > maxNestedGroupDepth {
		return nil
	}
	var groups [][]*token
	var current []*token
	for _, t := range tokenize(text) {
		if t.operator && (t.value == "," || t.value == ";") {
			if len(current) > 0 {
				groups = append(groups, current)
			}
			current = nil
		} else {
			current = append(current, t)
		}
	}
	if len(current) > 0 {
		groups = append(groups, current)
	}
	var parsed []*address
	for _, g := range groups {
		parsed = append(parsed, handleAddress(g, depth)...)
	}
	var merged []*address
	for i := len(parsed) - 1; i >= 0; i-- {
		cur := parsed[i]
		if n := len(merged); n > 0 {
			next := merged[n-1]
			if !cur.IsGroup && cur.Address == "" && cur.Name != "" && !next.IsGroup && next.Address != "" && next.Name != "" {
				next.Name = cur.Name + ", " + next.Name
				continue
			}
		}
		merged = append(merged, cur)
	}
	slices.Reverse(merged)
	return merged
}
