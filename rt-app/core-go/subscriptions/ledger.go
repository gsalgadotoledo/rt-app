// Package subscriptions ports the pure parts of the TypeScript subscriptions module
// (packages/subscriptions): the credit ledger (ledger.ts), credit settings validation and
// request pricing (validateCredits, estimate) and the currency catalog (currency.ts).
//
// Numbers are float64 with JavaScript semantics (Math.round, Number → String), so every
// result matches the reference byte for byte. See rt-app/docs/polyglot.md and the contracts
// spec/contracts/subscriptions-{ledger,credits}.contract.yaml.
package subscriptions

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"

	"rt.local/core-go/nosql"
)

// Credit ledger: an append-only, chronological statement per user (SUB_LEDGER#<userId>).
// Every entry is written in the same transaction as the account change it describes, so the
// statement and the balances can never disagree. Credits are signed: + credit, − debit.

// Kind is the kind of a ledger entry.
type Kind string

// Ledger entry kinds.
const (
	KindAllowance  Kind = "allowance"  // plan credits granted for a new window (weekly)
	KindExpiry     Kind = "expiry"     // unused plan credits of a closed window
	KindUsage      Kind = "usage"      // consumption (plan allowance first, then additional credits)
	KindGrant      Kind = "grant"      // additional credits assigned by an administrator
	KindPurchase   Kind = "purchase"   // additional credits bought (top-up)
	KindPlan       Kind = "plan"       // plan started, changed, renewed or assigned
	KindAdjustment Kind = "adjustment" // manual or programmatic correction
	KindReset      Kind = "reset"      // courtesy reset of usage windows
)

// Source is who caused a ledger entry.
type Source string

// Ledger entry sources.
const (
	SourceSystem  Source = "system"
	SourceAdmin   Source = "admin"
	SourceBilling Source = "billing"
	SourceUser    Source = "user"
	SourceAPI     Source = "api"
)

// Entry is one ledger entry. Optional string fields are omitted when empty. Fields this type
// does not know are kept in Extra and written back, like the TypeScript object spread.
type Entry struct {
	ID        string  `json:"id,omitempty"`
	At        float64 `json:"at"`
	Kind      Kind    `json:"kind"`
	Source    Source  `json:"source"`
	Credits   float64 `json:"credits"`
	ProductID string  `json:"productId,omitempty"`
	PlanID    string  `json:"planId,omitempty"`
	Reason    string  `json:"reason"`
	ActorID   string  `json:"actorId,omitempty"`
	RequestID string  `json:"requestId,omitempty"`
	// AmountMinor is money paid (purchase, plan) or the value recorded for an admin grant, in
	// minor units of Currency.
	AmountMinor *float64 `json:"amountMinor,omitempty"`
	Currency    string   `json:"currency,omitempty"`
	// FromAllowance and FromBalance split a usage debit between the plan allowance and
	// additional credits; Available is what the product has left right after this entry.
	FromAllowance *float64       `json:"fromAllowance,omitempty"`
	FromBalance   *float64       `json:"fromBalance,omitempty"`
	Available     *float64       `json:"available,omitempty"`
	Details       map[string]any `json:"details,omitempty"`
	Extra         map[string]any `json:"-"`
}

type entryFields Entry // Entry without its JSON methods

// MarshalJSON writes the known fields, Extra, and details when non-nil (even if empty).
func (e Entry) MarshalJSON() ([]byte, error) {
	extra := maps.Clone(e.Extra)
	if e.Details != nil && len(e.Details) == 0 {
		if extra == nil {
			extra = map[string]any{}
		}
		extra["details"] = map[string]any{}
	}
	return withExtra(entryFields(e), extra)
}

// UnmarshalJSON reads the known fields and keeps the others in Extra.
func (e *Entry) UnmarshalJSON(raw []byte) error {
	var fields entryFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	extra, err := unknownFields(raw, entryNames)
	if err != nil {
		return err
	}
	*e = Entry(fields)
	e.Extra = extra
	return nil
}

// Totals are the running totals stored on the account. Unknown fields are kept in Extra.
type Totals struct {
	CreditsIn  float64 `json:"creditsIn"`
	CreditsOut float64 `json:"creditsOut"`
	Expired    float64 `json:"expired"`
	// PaidMinor is money actually paid, per currency (purchases and paid plans).
	PaidMinor map[string]float64 `json:"paidMinor"`
	// GrantedValueMinor is the value recorded for administrative assignments, per currency.
	// It is not a charge.
	GrantedValueMinor map[string]float64 `json:"grantedValueMinor"`
	Extra             map[string]any     `json:"-"`
}

type totalsFields Totals

// MarshalJSON writes the known fields and Extra; nil currency maps are written as {}.
func (t Totals) MarshalJSON() ([]byte, error) {
	fields := totalsFields(t)
	if fields.PaidMinor == nil {
		fields.PaidMinor = map[string]float64{}
	}
	if fields.GrantedValueMinor == nil {
		fields.GrantedValueMinor = map[string]float64{}
	}
	return withExtra(fields, t.Extra)
}

// UnmarshalJSON reads the known fields and keeps the others in Extra.
func (t *Totals) UnmarshalJSON(raw []byte) error {
	var fields totalsFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	extra, err := unknownFields(raw, totalsNames)
	if err != nil {
		return err
	}
	*t = Totals(fields)
	t.Extra = extra
	return nil
}

// withExtra marshals known (a struct) and adds the extra fields it does not already have.
func withExtra(known any, extra map[string]any) ([]byte, error) {
	raw, err := json.Marshal(known)
	if err != nil || len(extra) == 0 {
		return raw, err
	}
	var merged map[string]any
	if err := json.Unmarshal(raw, &merged); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if _, taken := merged[k]; !taken {
			merged[k] = v
		}
	}
	return json.Marshal(merged)
}

// unknownFields returns the fields of the JSON object raw that are not in known, decoded as
// JSON values; nil when there are none.
func unknownFields(raw []byte, known map[string]bool) (map[string]any, error) {
	var all map[string]any
	if err := json.Unmarshal(raw, &all); err != nil {
		return nil, err
	}
	for name := range known {
		delete(all, name)
	}
	if len(all) == 0 {
		return nil, nil
	}
	return all, nil
}

var (
	entryNames = setOf("id", "at", "kind", "source", "credits", "productId", "planId", "reason", "actorId",
		"requestId", "amountMinor", "currency", "fromAllowance", "fromBalance", "available", "details")
	totalsNames = setOf("creditsIn", "creditsOut", "expired", "paidMinor", "grantedValueMinor")
)

func setOf(names ...string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	return set
}

// EmptyTotals returns zero counters and empty currency maps.
func EmptyTotals() Totals {
	return Totals{PaidMinor: map[string]float64{}, GrantedValueMinor: map[string]float64{}}
}

// Ledger returns the statement partition of a user: "SUB_LEDGER#" + userID.
func Ledger(userID string) string { return "SUB_LEDGER#" + userID }

// LedgerKey returns the sort key of an entry: the time zero-padded to 15 characters, the
// account's write sequence (order within one millisecond) padded to 10, then the first 16 hex
// digits of SHA-256(UTF-8 seed), so a partition lists in chronological order. Numbers use
// JavaScript Number → String and padding never truncates.
//
// Example: LedgerKey(1788220800000, "abc", 7) = "001788220800000-0000000007-ba7816bf8f01cfea".
func LedgerKey(at float64, seed string, sequence float64) string {
	sum := sha256.Sum256([]byte(wellFormed(seed)))
	return padStart(NumberString(at), 15) + "-" + padStart(NumberString(sequence), 10) + "-" + hex.EncodeToString(sum[:])[:16]
}

// padStart is JavaScript padStart(n, "0") for ASCII text: it pads and never truncates.
func padStart(s string, n int) string {
	return strings.Repeat("0", max(0, n-len(s))) + s
}

// Written is an entry with its key and the conditional create that stores it.
type Written struct {
	Entry Entry       `json:"entry"`
	Write nosql.Write `json:"write"`
}

// LedgerWrite builds the entry write: the entry gets ID = LedgerKey(entry.At, seed, sequence)
// (a given ID is replaced) and the write is a conditional create (Expected nil), so a
// replayed key never writes twice. The caller's entry is not modified.
func LedgerWrite(userID string, entry Entry, seed string, sequence float64) (Written, error) {
	entry.ID = LedgerKey(entry.At, seed, sequence)
	raw, err := json.Marshal(entry)
	if err != nil {
		return Written{}, err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return Written{}, err
	}
	row := nosql.Row{PK: Ledger(userID), SK: entry.ID, Version: 1, Data: data}
	return Written{Entry: entry, Write: nosql.Write{Row: row}}, nil
}

// ApplyTotals folds one entry into a copy of the running totals (EmptyTotals when nil) and
// returns it; totals is never modified.
//
// An expiry adds -credits to Expired (whatever its sign). Other entries add positive credits
// to CreditsIn and -credits to CreditsOut otherwise. Money counts only when AmountMinor is
// non-zero and Currency is set: grants and admin entries add to GrantedValueMinor, the rest to
// PaidMinor. Currencies are case-sensitive keys.
func ApplyTotals(totals *Totals, entry Entry) Totals {
	next := EmptyTotals()
	if totals != nil {
		next = Totals{
			CreditsIn:         totals.CreditsIn,
			CreditsOut:        totals.CreditsOut,
			Expired:           totals.Expired,
			PaidMinor:         cloneAmounts(totals.PaidMinor),
			GrantedValueMinor: cloneAmounts(totals.GrantedValueMinor),
		}
		if totals.Extra != nil {
			next.Extra = cloneJSON(totals.Extra).(map[string]any)
		}
	}
	switch {
	case entry.Kind == KindExpiry:
		next.Expired += -entry.Credits
	case entry.Credits > 0:
		next.CreditsIn += entry.Credits
	default:
		next.CreditsOut += -entry.Credits
	}
	// JavaScript truthiness: 0 and NaN amounts, and "" currencies, record no money.
	if a := entry.AmountMinor; a != nil && *a != 0 && !math.IsNaN(*a) && entry.Currency != "" {
		bucket := next.PaidMinor
		if entry.Kind == KindGrant || entry.Source == SourceAdmin {
			bucket = next.GrantedValueMinor
		}
		bucket[entry.Currency] += *a
	}
	return next
}

func cloneAmounts(m map[string]float64) map[string]float64 {
	if m == nil {
		return map[string]float64{}
	}
	return maps.Clone(m)
}

// Allowance windows ------------------------------------------------------------------------

// Window is the last settled allowance window of one product.
type Window struct {
	ID          string  `json:"-"`
	Start       float64 `json:"start"`
	Allowance   float64 `json:"allowance"`
	Name        string  `json:"name"`
	WeekSeconds float64 `json:"weekSeconds"`
}

// WindowState is the last settled window per product, stored on the account. Key is the
// entitlement identity: a different key (plan change, admin assignment) closes all windows.
//
// In JSON, Products is an object keyed by product ID. Its order is JavaScript property order,
// which Rollover observes: array-index keys ("0", "7", "10") ascending, then the other keys
// in insertion order. UnmarshalJSON keeps that order.
type WindowState struct {
	Key      string
	Products []Window
}

// MarshalJSON writes {"key": …, "products": {id: window, …}} in Products order.
func (s WindowState) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	key, err := json.Marshal(s.Key)
	if err != nil {
		return nil, err
	}
	buf.WriteString(`{"key":`)
	buf.Write(key)
	buf.WriteString(`,"products":{`)
	for i, w := range s.Products {
		if i > 0 {
			buf.WriteByte(',')
		}
		id, err := json.Marshal(w.ID)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(w)
		if err != nil {
			return nil, err
		}
		buf.Write(id)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteString("}}")
	return buf.Bytes(), nil
}

// UnmarshalJSON reads the products object preserving JavaScript property order. A repeated
// key keeps its first position and its last value, like JSON.parse.
func (s *WindowState) UnmarshalJSON(raw []byte) error {
	var fields struct {
		Key      string          `json:"key"`
		Products json.RawMessage `json:"products"`
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	products, err := orderedObject(fields.Products)
	if err != nil {
		return fmt.Errorf("products: %w", err)
	}
	state := WindowState{Key: fields.Key}
	for _, p := range products {
		var w Window
		if err := json.Unmarshal(p.value, &w); err != nil {
			return fmt.Errorf("products.%s: %w", p.key, err)
		}
		w.ID = p.key
		state.Products = putWindow(state.Products, w)
	}
	*s = state
	return nil
}

// window returns the product's window (nil when absent).
func (s *WindowState) window(id string) *Window {
	for i := range s.Products {
		if s.Products[i].ID == id {
			return &s.Products[i]
		}
	}
	return nil
}

// putWindow sets a property like a JavaScript assignment: an existing key keeps its position,
// a new array-index key goes before the first larger index or string key, others go last.
func putWindow(list []Window, w Window) []Window {
	for i := range list {
		if list[i].ID == w.ID {
			list[i] = w
			return list
		}
	}
	index, isIndex := arrayIndex(w.ID)
	if !isIndex {
		return append(list, w)
	}
	at := slices.IndexFunc(list, func(other Window) bool {
		n, ok := arrayIndex(other.ID)
		return !ok || n > index
	})
	if at < 0 {
		return append(list, w)
	}
	return slices.Insert(list, at, w)
}

// arrayIndex reports whether key is a JavaScript array index: the canonical decimal form of
// an integer 0 ≤ n ≤ 2^32 − 2.
func arrayIndex(key string) (uint64, bool) {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return n, err == nil && n <= 1<<32-2
}

type property struct {
	key   string
	value json.RawMessage
}

// orderedObject decodes a JSON object into its properties in document order (null or an
// absent value gives none).
func orderedObject(raw json.RawMessage) ([]property, error) {
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("expected an object")
	}
	var props []property
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		props = append(props, property{key: tok.(string), value: value})
	}
	return props, nil
}

// CurrentWindow is the current usage window of an entitlement. Weekly windows restart at
// every period boundary (e.g. 30-day renewals).
type CurrentWindow struct {
	Key         string           `json:"key"`
	PeriodStart float64          `json:"periodStart"`
	PeriodMs    float64          `json:"periodMs"`
	Products    []CurrentProduct `json:"products"`
}

// CurrentProduct is one product of the current window.
type CurrentProduct struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	WeeklyLimit float64 `json:"weeklyLimit"`
	WeekSeconds float64 `json:"weekSeconds"`
	Start       float64 `json:"start"`
}

// Pending is a ledger entry produced by Rollover, before it gets its key (from Seed) and source.
type Pending struct {
	At        float64        `json:"at"`
	Kind      Kind           `json:"kind"`
	Credits   float64        `json:"credits"`
	ProductID string         `json:"productId"`
	Reason    string         `json:"reason"`
	Details   *ExpiryDetails `json:"details,omitempty"`
	Seed      string         `json:"seed"`
}

// ExpiryDetails explains an expiry: the unused allowance of the closed window and the idle
// windows folded into it.
type ExpiryDetails struct {
	Unused       float64 `json:"unused"`
	SkippedWeeks int     `json:"skippedWeeks"`
}

// Rolled is the result of Rollover.
type Rolled struct {
	Entries []Pending    `json:"entries"`
	State   *WindowState `json:"state"`
}

// UsedFunc returns the allowance consumed in the settled window of a product starting at start.
type UsedFunc func(productID string, start float64) float64

// maxSkipped bounds the idle walk (about ten years of weekly windows).
const maxSkipped = 520

// Rollover is the pure window accounting between the last settled state and the current
// usage windows. Closed windows expire their unused plan allowance; each new window grants a
// fresh one. Idle windows are folded into one expiry, so the statement stays bounded.
// previous and current may be nil. Nothing reads the clock: now is epoch milliseconds.
//
// Entries are ordered by At; within the same At, expiries come first in reverse generation
// order, then allowances in generation order (what V8's sort does with the reference
// comparator). Expiries are generated in previous.Products order.
//
// Example: previous {api: start 0, allowance 500}, current start 604800000, used 120 →
// expiry −380 at 604800000, then allowance +500 at 604800000.
func Rollover(previous *WindowState, current *CurrentWindow, used UsedFunc, now float64) Rolled {
	entries := []Pending{}
	continuing := previous != nil && current != nil && previous.Key == current.Key
	if previous != nil {
		for _, w := range previous.Products {
			if e, ok := closeWindow(previous.Key, w, current, continuing, used, now); ok {
				entries = append(entries, e)
			}
		}
	}
	var state *WindowState
	if current != nil {
		state = &WindowState{Key: current.Key}
		for _, p := range current.Products {
			state.Products = putWindow(state.Products, Window{ID: p.ID, Start: p.Start, Allowance: p.WeeklyLimit, Name: p.Name, WeekSeconds: p.WeekSeconds})
		}
		for _, p := range current.Products {
			if continuing {
				if known := previous.window(p.ID); known != nil && known.Start == p.Start {
					continue
				}
			}
			at := p.Start
			// A plan change mid-window opens the new allowance when it happens, after the old one closed.
			if previous != nil && !continuing {
				at = math.Max(p.Start, now)
			}
			entries = append(entries, Pending{
				At:        at,
				Kind:      KindAllowance,
				Credits:   p.WeeklyLimit,
				ProductID: p.ID,
				Reason:    p.Name + ": weekly allowance",
				Seed:      "allowance:" + current.Key + ":" + p.ID + ":" + NumberString(p.Start) + ":" + NumberString(now),
			})
		}
	}
	return Rolled{Entries: sortEntries(entries), State: state}
}

// closeWindow returns the expiry of a settled window, if it closed with credits left.
func closeWindow(key string, w Window, current *CurrentWindow, continuing bool, used UsedFunc, now float64) (Pending, bool) {
	step := w.WeekSeconds * 1000
	var next *CurrentProduct
	if continuing {
		if i := slices.IndexFunc(current.Products, func(p CurrentProduct) bool { return p.ID == w.ID }); i >= 0 {
			next = &current.Products[i]
		}
	}
	if next != nil && next.Start == w.Start {
		return Pending{}, false
	}
	// Same arithmetic as the usage counters: a window ends after step or at the period boundary.
	following := func(start float64) float64 {
		if current == nil {
			return start + step
		}
		periodEnd := current.PeriodStart + (math.Floor((start-current.PeriodStart)/current.PeriodMs)+1)*current.PeriodMs
		return math.Min(start+step, periodEnd)
	}
	// A window closes at its natural end, or now when the entitlement changed mid-window.
	closedAt := math.Min(w.Start+step, now)
	if next != nil {
		closedAt = math.Min(following(w.Start), next.Start)
	}
	skipped := 0
	if next != nil {
		for start := closedAt; start < next.Start && skipped < maxSkipped; start = following(start) {
			skipped++
		}
	}
	consumed := 0.0
	if used != nil {
		consumed = used(w.ID, w.Start)
	}
	unused := math.Max(0, w.Allowance-consumed)
	expired := unused + float64(skipped)*w.Allowance
	if !(expired > 0) {
		return Pending{}, false
	}
	reason := w.Name + ": allowance ended with the plan"
	switch {
	case skipped > 0:
		reason = w.Name + ": unused allowance of " + strconv.Itoa(skipped+1) + " weeks expired"
	case next != nil:
		reason = w.Name + ": unused weekly allowance expired"
	}
	return Pending{
		At:        closedAt,
		Kind:      KindExpiry,
		Credits:   -expired,
		ProductID: w.ID,
		Reason:    reason,
		Details:   &ExpiryDetails{Unused: unused, SkippedWeeks: skipped},
		// now distinguishes a window closed, reopened and closed again; the account version
		// (same transaction) already prevents concurrent duplicates.
		Seed: "expiry:" + key + ":" + w.ID + ":" + NumberString(w.Start) + ":" + NumberString(now),
	}, true
}

// sortEntries orders entries like the reference entries.sort((a, b) => a.at - b.at ||
// (a.kind === "expiry" ? -1 : 1)) does in V8: stable by time; within the same time the
// comparator always places an expiry before what it is compared with, so expiries end up in
// reverse generation order ahead of the allowances, which keep their order.
func sortEntries(entries []Pending) []Pending {
	type ranked struct {
		Pending
		index int
	}
	list := make([]ranked, len(entries))
	for i, e := range entries {
		list[i] = ranked{e, i}
	}
	slices.SortStableFunc(list, func(a, b ranked) int {
		if a.At != b.At {
			if a.At < b.At {
				return -1
			}
			return 1
		}
		aExpiry, bExpiry := a.Kind == KindExpiry, b.Kind == KindExpiry
		switch {
		case aExpiry && bExpiry:
			return b.index - a.index
		case aExpiry:
			return -1
		case bExpiry:
			return 1
		}
		return a.index - b.index
	})
	out := make([]Pending, len(list))
	for i, r := range list {
		out[i] = r.Pending
	}
	return out
}
