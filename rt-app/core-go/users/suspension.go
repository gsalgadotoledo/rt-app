package users

// Account suspension (bans) as stored on the USERS row. The users package owns the row format and
// this reader, so every sign-in path (package auth) enforces a ban even when the bans package that
// writes them is not composed. Row format and algorithm: rt-app/docs/polyglot/users-bans.md and
// spec/contracts/users-bans.contract.yaml.

import (
	"regexp"
	"strconv"
	"time"
)

// AccountSuspended is the single public message of every refused sign-in, refresh or request
// of a banned account (HTTP 403).
const AccountSuspended = "Account suspended"

// MaxInstantMs is the latest instant ParseInstant accepts: 9999-12-31T23:59:59.999Z.
const MaxInstantMs int64 = 253402300799999

var instant = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$`)

// ParseInstant reads a strict ISO 8601 instant (the grammar of the TypeScript parseInstant):
// YYYY-MM-DDTHH:MM:SS, optional .f to .fff, then Z or ±HH:MM; ASCII digits, a real calendar date,
// year 1970 or later, at most MaxInstantMs once the offset is applied. ok is false otherwise.
//
//	ParseInstant("2026-01-02T03:04:05+01:00") // 1767319445000, true
func ParseInstant(value any) (ms int64, ok bool) {
	s, isString := value.(string)
	if !isString {
		return 0, false
	}
	m := instant.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	n := func(i int) int {
		v, _ := strconv.Atoi(m[i])
		return v
	}
	year, month, day, hour, minute, second := n(1), n(2), n(3), n(4), n(5), n(6)
	fraction, _ := strconv.Atoi((m[7] + "000")[:3])
	offsetHours, offsetMinutes := 0, 0
	if m[9] != "" {
		offsetHours, offsetMinutes = n(10), n(11)
	}
	daysInMonth := time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
		hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59 {
		return 0, false
	}
	sign := int64(1)
	if m[9] == "-" {
		sign = -1
	}
	ms = time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC).UnixMilli() + int64(fraction) -
		sign*int64(offsetHours*60+offsetMinutes)*60000
	if ms < 0 || ms > MaxInstantMs {
		return 0, false
	}
	return ms, true
}

// ActiveBan returns the ban in force on a user row at nowMs ({reason, category, until, at, by}),
// or nil. until nil is permanent; a temporary ban lifts by itself when until <= now (nothing is
// written). An until that cannot be read keeps the ban in force (fail closed).
func ActiveBan(data map[string]any, nowMs int64) map[string]any {
	ban, ok := data["ban"].(map[string]any)
	if !ok {
		return nil
	}
	if until := ban["until"]; until != nil {
		if ms, ok := ParseInstant(until); ok && ms <= nowMs {
			return nil
		}
	}
	return map[string]any{"reason": ban["reason"], "category": ban["category"], "until": ban["until"], "at": ban["at"], "by": ban["by"]}
}

// ViewAccount is the admin view of an account (GET /users, GET /users/:id): ViewUser plus banned
// and the ban in force (null when none).
func ViewAccount(data map[string]any, nowMs int64) map[string]any {
	view := ViewUser(data)
	view["banned"] = false
	view["ban"] = nil
	if ban := ActiveBan(data, nowMs); ban != nil {
		view["banned"], view["ban"] = true, ban
	}
	return view
}

// View is the admin view of a row at the current time of the Users clock.
func (u *Users) View(data map[string]any) map[string]any {
	return ViewAccount(data, u.now().UnixMilli())
}

// Now is the Users clock (bans share it for audit timestamps).
func (u *Users) Now() time.Time { return u.now() }
