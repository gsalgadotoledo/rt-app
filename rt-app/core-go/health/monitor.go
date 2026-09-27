package health

import (
	"context"
	"sync"
)

// Alert is an availability notification: a service went down, or came back up.
type Alert struct {
	Service string `json:"service"`
	Status  string `json:"status"`
	At      string `json:"at"`
}

// Monitor alerts outages and recoveries. Run it from an independent worker or scheduler: a
// stopped API cannot report its own outage.
type Monitor struct {
	checks *Checks
	notify func(context.Context, Alert) error

	mu     sync.Mutex
	states map[string]string
	flight flight[Report]
}

// NewMonitor polls checks and calls notify for initial failures and later transitions.
func NewMonitor(checks *Checks, notify func(context.Context, Alert) error) *Monitor {
	return &Monitor{checks: checks, notify: notify, states: map[string]string{}}
}

// Poll runs the checks (concurrent polls share one run) and notifies, in check order, each
// status that differs from the previous poll, or a first status that is down. A check's state
// is saved only after its notification succeeds: a failing notification ends the poll with its
// error, and that check and the remaining ones are retried by the next poll.
func (m *Monitor) Poll(ctx context.Context) (Report, error) {
	return m.flight.do(ctx, func() (Report, error) { return m.run(context.WithoutCancel(ctx)) })
}

func (m *Monitor) run(ctx context.Context) (Report, error) {
	report, err := m.checks.Report(ctx)
	if err != nil {
		return Report{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, check := range report.Checks {
		previous, known := m.states[check.ID]
		if (known && previous != check.Status) || (!known && check.Status == Down) {
			if err := m.notify(ctx, Alert{Service: check.ID, Status: check.Status, At: report.At}); err != nil {
				return Report{}, err
			}
		}
		m.states[check.ID] = check.Status
	}
	return report, nil
}
