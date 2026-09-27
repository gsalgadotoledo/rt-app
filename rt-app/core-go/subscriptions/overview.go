package subscriptions

import (
	"context"
	"math"
	"slices"
	"strings"
	"time"

	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// Overview returns customers, paying customers, projected monthly revenue per currency, new and
// canceled subscriptions today, this month and per month (months: 1..36; nil means 12), and
// records today's snapshot (SUB_STATS snap:<date>).
func (s *Subscriptions) Overview(ctx context.Context, months any) (map[string]any, error) {
	if months == nil {
		months = 12.0
	}
	count, err := integer(months, 1, 36)
	if err != nil {
		return nil, err
	}
	now := s.now()
	today := dayKey(now)
	month := today[:7]
	customers, paying, canceling := 0.0, 0.0, 0.0
	mrr := map[string]any{}
	var planOrder []string
	byPlan := map[string]map[string]any{}
	cursor := ""
	for {
		page, err := s.store.List(ctx, "SUB_ACCOUNTS", cursor)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			data := s.normalized(row.Data)
			e, _ := s.effective(data)
			if !truthy(e["plan"]) || e["status"] != "active" || now >= num(e["periodEnd"]) {
				continue
			}
			customers++
			plan := obj(e["plan"])
			planID := jsString(plan["id"])
			summary, ok := byPlan[planID]
			if !ok {
				summary = map[string]any{"planId": planID, "name": plan["name"], "customers": 0.0, "paying": 0.0}
				byPlan[planID] = summary
				planOrder = append(planOrder, planID)
			}
			summary["customers"] = num(summary["customers"]) + 1
			if truthy(e["cancelAtPeriodEnd"]) {
				canceling++
			}
			if s.provider != nil && e["mode"] == s.provider.Mode() && num(plan["amount"]) > 0 {
				paying++
				summary["paying"] = num(summary["paying"]) + 1
				if !truthy(e["cancelAtPeriodEnd"]) {
					currency := jsString(plan["currency"])
					mrr[currency] = numOr(mrr[currency], 0) + jsRound(num(plan["amount"])*30/num(plan["periodDays"]))
				}
			}
		}
		if cursor = page.Cursor; cursor == "" {
			break
		}
	}
	snapshotKey := "snap:" + today
	snapshot := map[string]any{"customers": customers, "paying": paying, "canceling": canceling, "mrrMinor": mrr, "at": now}
	if _, err := retry(func() (any, error) {
		old, err := s.store.Get(ctx, "SUB_STATS", snapshotKey)
		if err != nil {
			return nil, err
		}
		return nil, s.store.Transact(ctx, []nosql.Write{write(old, "SUB_STATS", snapshotKey, snapshot)})
	}); err != nil {
		return nil, err
	}
	days := map[string][2]float64{}
	snapshots := map[string]map[string]any{}
	cursor = ""
	for {
		page, err := s.store.List(ctx, "SUB_STATS", cursor)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			if d, ok := strings.CutPrefix(row.SK, "day:"); ok {
				days[d] = [2]float64{numOr(row.Data["new"], 0), numOr(row.Data["canceled"], 0)}
			} else if d, ok := strings.CutPrefix(row.SK, "snap:"); ok {
				snapshots[d] = row.Data
			}
		}
		if cursor = page.Cursor; cursor == "" {
			break
		}
	}
	sum := func(prefix string, field int) float64 {
		total := 0.0
		for d, v := range days {
			if strings.HasPrefix(d, prefix) {
				total += v[field]
			}
		}
		return total
	}
	at := time.UnixMilli(int64(now)).UTC()
	series := make([]any, 0, int(count))
	for i := 0; i < int(count); i++ {
		key := time.Date(at.Year(), at.Month()-time.Month(int(count)-1-i), 1, 0, 0, 0, 0, time.UTC).Format("2006-01")
		var keys []string
		for d := range snapshots {
			if strings.HasPrefix(d, key) {
				keys = append(keys, d)
			}
		}
		var customersAt, payingAt any
		if len(keys) > 0 {
			last := slices.Max(keys)
			customersAt, payingAt = snapshots[last]["customers"], snapshots[last]["paying"]
		}
		series = append(series, map[string]any{"month": key, "customers": customersAt, "paying": payingAt, "new": sum(key, 0), "canceled": sum(key, 1)})
	}
	plans := make([]any, 0, len(planOrder))
	for _, planID := range jsKeys(planOrder, planOrder) {
		plans = append(plans, byPlan[planID])
	}
	todayCounts := days[today]
	return map[string]any{
		"asOf": now, "customers": customers, "paying": paying, "canceling": canceling, "mrrMinor": mrr, "plans": plans,
		"today":  map[string]any{"date": today, "new": todayCounts[0], "canceled": todayCounts[1]},
		"month":  map[string]any{"month": month, "new": sum(month, 0), "canceled": sum(month, 1)},
		"series": series,
	}, nil
}

// Maintenance renews idle unpaid accounts, settles closed windows, queues period reminders and
// sends queued notices, 100 accounts per run from a stored cursor (15 s of wall time at most).
func (s *Subscriptions) Maintenance(ctx context.Context) (map[string]any, error) {
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := settings["values"].(map[string]any)
	notifications := values["notifications"] == true
	checkpoint, err := s.store.Get(ctx, "SUB_MAINTENANCE", "cursor")
	if err != nil {
		return nil, err
	}
	cursor := str(rowData(checkpoint)["accounts"])
	processed := 0
	deadline := time.Now().Add(15 * time.Second)
	ignoreConflict := func(err error) error {
		if err != nil && !isConflict(err) {
			return err
		}
		return nil
	}
	for {
		page, err := s.store.List(ctx, "SUB_ACCOUNTS", cursor)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			d := row.Data
			if !truthy(d["plan"]) {
				continue
			}
			now := s.now()
			renew := d["mode"] == "none" && !truthy(d["cancelAtPeriodEnd"]) && now >= num(d["periodEnd"])
			source := d
			if renew {
				step := num(obj(d["plan"])["periodDays"]) * day
				periods := math.Floor((now - num(d["periodStart"])) / step)
				source = spread(d, map[string]any{"periodStart": num(d["periodStart"]) + periods*step, "periodEnd": num(d["periodStart"]) + (periods+1)*step, "counters": map[string]any{}})
			}
			next := s.normalized(source)
			settled := s.settle(row.SK, d, next)
			if renew || len(settled) > 0 {
				r := row
				if err := ignoreConflict(s.store.Transact(ctx, append([]nosql.Write{write(&r, row.PK, row.SK, next)}, settled...))); err != nil {
					return nil, err
				}
			}
			now = s.now()
			if notifications && d["notifications"] != false && truthy(d["email"]) && num(d["periodEnd"])-now <= num(values["reminderDays"])*day && num(d["periodEnd"]) > now {
				key := strOf(d["userId"], "undefined") + "-" + jsString(d["periodEnd"])
				existing, err := s.store.Get(ctx, "SUB_MAIL", key)
				if err != nil {
					return nil, err
				}
				if existing == nil {
					mail := map[string]any{"userId": d["userId"], "to": d["email"], "subject": "Subscription period ending", "text": "Your current subscription period ends on " + isoTime(num(d["periodEnd"])), "sent": false}
					if err := ignoreConflict(s.store.Transact(ctx, []nosql.Write{write(nil, "SUB_MAIL", key, mail)})); err != nil {
						return nil, err
					}
				}
			}
		}
		cursor = page.Cursor
		processed += len(page.Items)
		if cursor == "" || processed >= 100 || !time.Now().Before(deadline) {
			break
		}
	}
	mailCursor := str(rowData(checkpoint)["mail"])
	if s.notify != nil && time.Now().Before(deadline) {
		start := mailCursor
		mails, err := s.store.List(ctx, "SUB_MAIL", mailCursor)
		if err != nil {
			return nil, err
		}
		mailCursor = mails.Cursor
		for _, row := range mails.Items {
			if !time.Now().Before(deadline) {
				mailCursor = start
				break
			}
			now := s.now()
			if truthy(row.Data["sent"]) || num(row.Data["lockUntil"]) > now || !notifications {
				continue
			}
			if truthy(row.Data["userId"]) {
				account, err := s.account(ctx, jsString(row.Data["userId"]))
				if err != nil {
					return nil, err
				}
				if rowData(account)["notifications"] == false {
					continue
				}
			}
			r := row
			claim := write(&r, row.PK, row.SK, spread(row.Data, map[string]any{"lockUntil": now + 60000}))
			if err := s.store.Transact(ctx, []nosql.Write{claim}); err != nil {
				if isConflict(err) {
					continue
				}
				return nil, err
			}
			mail := Mail{To: js.String(row.Data["to"]), Subject: js.String(row.Data["subject"]), Text: js.String(row.Data["text"])}
			if s.notify(ctx, mail) == nil {
				claimed := claim.Row
				_ = s.store.Transact(ctx, []nosql.Write{write(&claimed, row.PK, row.SK, spread(claim.Row.Data, map[string]any{"sent": true}))})
			}
		}
	}
	nullable := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	err = s.store.Transact(ctx, []nosql.Write{write(checkpoint, "SUB_MAINTENANCE", "cursor", map[string]any{"accounts": nullable(cursor), "mail": nullable(mailCursor)})})
	if err := ignoreConflict(err); err != nil {
		return nil, err
	}
	return map[string]any{"processed": float64(processed), "partial": cursor != "" || mailCursor != ""}, nil
}
