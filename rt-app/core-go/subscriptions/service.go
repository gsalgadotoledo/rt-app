package subscriptions

import (
	"context"
	"regexp"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
)

// Subscriptions is the subscriptions service (port of the TypeScript Subscriptions class in
// packages/subscriptions/src/index.ts): settings and the plan catalog, accounts, paid plans
// through a BillingProvider, credit consumption and the ledger, overview and maintenance.
// Contracts: spec/contracts/subscriptions-{settings,accounts,usage,overview,api}.contract.yaml.
type Subscriptions struct {
	store    nosql.Store
	provider BillingProvider
	notify   func(context.Context, Mail) error
	now      func() float64
	catalog  func(secret string) CatalogPublisher
	newID    func() string
}

// Option configures the service.
type Option func(*Subscriptions)

// WithProvider sets the payment adapter (none by default).
func WithProvider(p BillingProvider) Option { return func(s *Subscriptions) { s.provider = p } }

// WithNotifier sets the mail sender used by Maintenance (none by default: notices stay queued).
func WithNotifier(n func(context.Context, Mail) error) Option {
	return func(s *Subscriptions) { s.notify = n }
}

// WithClock sets the clock in epoch milliseconds (the system clock by default).
func WithClock(now func() float64) Option { return func(s *Subscriptions) { s.now = now } }

// WithCatalog sets the catalog publisher factory; secret is a per-request key ("" when none).
func WithCatalog(factory func(secret string) CatalogPublisher) Option {
	return func(s *Subscriptions) { s.catalog = factory }
}

// WithIDs sets the random id generator (UUID v4 by default), for tests.
func WithIDs(newID func() string) Option { return func(s *Subscriptions) { s.newID = newID } }

// New returns the service over store.
func New(store nosql.Store, options ...Option) *Subscriptions {
	s := &Subscriptions{store: store, now: func() float64 { return float64(time.Now().UnixMilli()) }, newID: uuid.New}
	for _, o := range options {
		o(s)
	}
	return s
}

// Store is the service's store.
func (s *Subscriptions) Store() nosql.Store { return s.store }

// Provider is the payment adapter (nil when none).
func (s *Subscriptions) Provider() BillingProvider { return s.provider }

func (s *Subscriptions) providerMode() any {
	if s.provider == nil {
		return nil
	}
	return s.provider.Mode()
}

func (s *Subscriptions) audit(data map[string]any) nosql.Write {
	return write(nil, "SUB_AUDIT", s.newID(), data)
}

// Settings returns {version, values, provider, catalogAvailable, catalogOperation}.
func (s *Subscriptions) Settings(ctx context.Context) (map[string]any, error) {
	row, err := s.store.Get(ctx, "SUB_CONFIG", "settings")
	if err != nil {
		return nil, err
	}
	data := rowData(row)
	values := cloneMap(data)
	defaults := Defaults()
	if row == nil {
		values = defaults
	}
	plans := list(data["plans"])
	if data["plans"] == nil {
		plans = list(defaults["plans"])
	}
	viewed := make([]any, 0, len(plans))
	for _, p := range plans {
		plan := spread(cloneMap(obj(p)))
		plan["version"] = orDefault(plan["version"], "0.0.1")
		viewed = append(viewed, plan)
	}
	values["plans"] = viewed
	values["credits"] = orDefault(cloneJSON(data["credits"]), defaults["credits"])
	version := 0
	if row != nil {
		version = row.Version
	}
	provider := any("none")
	if s.provider != nil {
		provider = s.provider.Mode()
	}
	return map[string]any{
		"version": float64(version), "values": values, "provider": provider,
		"catalogAvailable": s.catalog != nil, "catalogOperation": cloneJSON(data["catalogOperation"]),
	}, nil
}

// Restored marks a plan saved as a restored (or re-versioned) plan.
type Restored struct {
	ID      any
	Version any
}

// SaveSettings saves {version, values} with optimistic concurrency and plan versioning.
func (s *Subscriptions) SaveSettings(ctx context.Context, input any, actorID string, restored *Restored) (map[string]any, error) {
	in := obj(input)
	values, err := validateSettings(in["values"])
	if err != nil {
		return nil, err
	}
	old, err := s.store.Get(ctx, "SUB_CONFIG", "settings")
	if err != nil {
		return nil, err
	}
	oldVersion := 0.0
	if old != nil {
		oldVersion = float64(old.Version)
	}
	if v, ok := in["version"].(float64); !ok || v != oldVersion {
		return nil, apperr.Conflict()
	}
	oldData := rowData(old)
	if truthy(oldData["catalogOperation"]) {
		return nil, apperr.New(409, "Resume the pending Stripe synchronization before editing plans")
	}
	var history []nosql.Write
	previousPlans := list(oldData["plans"])
	if oldData["plans"] == nil {
		previousPlans = list(Defaults()["plans"])
	}
	plans := list(values["plans"])
	find := func(list []any, planID any) map[string]any {
		for _, p := range list {
			if m := obj(p); m != nil && m["id"] == planID {
				return m
			}
		}
		return nil
	}
	for _, prior := range previousPlans {
		if find(plans, obj(prior)["id"]) == nil {
			return nil, apperr.BadRequest("Disable a plan instead of removing or renaming its ID")
		}
	}
	for i, item := range plans {
		plan := obj(item)
		prior := find(previousPlans, plan["id"])
		changed := prior != nil && ((restored != nil && restored.ID == plan["id"]) || !sameContent(planContent(prior), planContent(plan)))
		version := "0.0.1"
		if prior != nil && prior["version"] != nil {
			version = jsString(prior["version"])
		}
		if changed {
			history = append(history, write(nil, "SUB_PLAN_HISTORY#"+jsString(prior["id"]), version, prior))
		}
		next := spread(plan)
		next["stripeManaged"] = prior != nil && truthy(prior["stripeManaged"])
		if changed {
			next["version"] = bumpVersion(version)
		} else {
			next["version"] = version
		}
		if !changed && prior != nil && truthy(prior["stripePriceId"]) {
			next["stripePriceId"] = prior["stripePriceId"]
		} else {
			delete(next, "stripePriceId")
		}
		if !changed && prior != nil && truthy(prior["stripeProductId"]) {
			next["stripeProductId"] = prior["stripeProductId"]
		}
		plans[i] = next
	}
	if values["paymentRequired"] == true && s.provider == nil {
		return nil, apperr.BadRequest("Configure a payment adapter before requiring payments")
	}
	auditData := map[string]any{"action": "settings", "actorId": actorID, "at": s.now()}
	if restored != nil {
		auditData["restoredPlan"], auditData["restoredFrom"] = restored.ID, restored.Version
	}
	writes := []nosql.Write{write(old, "SUB_CONFIG", "settings", spread(values, map[string]any{"catalogNamespace": oldData["catalogNamespace"]}))}
	writes = append(writes, history...)
	writes = append(writes, s.audit(auditData))
	if err := s.store.Transact(ctx, writes); err != nil {
		return nil, err
	}
	return s.Settings(ctx)
}

// EditPlan applies one catalog action (create, update, archive, unarchive, version) to
// {version, id, plan} through SaveSettings.
func (s *Subscriptions) EditPlan(ctx context.Context, action string, input any, actorID string) (map[string]any, error) {
	in := obj(input)
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	if v, ok := in["version"].(float64); !ok || v != settings["version"] {
		return nil, apperr.Conflict()
	}
	values := settings["values"].(map[string]any)
	plans := list(values["plans"])
	index := -1
	for i, p := range plans {
		if obj(p)["id"] == in["id"] && in["id"] != nil {
			index = i
			break
		}
	}
	var restored *Restored
	if action == "create" {
		plan := obj(in["plan"])
		name, ok := plan["name"].(string)
		if !truthy(in["plan"]) || !ok {
			return nil, apperr.BadRequest("plan.name is required")
		}
		ids := make([]string, len(plans))
		for i, p := range plans {
			ids[i] = jsString(obj(p)["id"])
		}
		planID := PlanIDFromName(name, ids)
		family := plan["family"]
		if !truthy(family) {
			family = planID
		}
		plans = append(plans, spread(plan, map[string]any{"id": planID, "family": family, "enabled": false}))
		values["plans"] = plans
	} else {
		if index < 0 {
			return nil, apperr.NotFound("Plan not found")
		}
		current := obj(plans[index])
		switch action {
		case "update":
			plans[index] = spread(current, obj(in["plan"]), map[string]any{"id": current["id"]})
		case "archive", "unarchive":
			plans[index] = spread(current, map[string]any{"archived": action == "archive", "enabled": false})
		case "version":
			restored = &Restored{ID: in["id"], Version: orDefault(current["version"], "0.0.1")}
		default:
			return nil, apperr.BadRequest("Unknown plan action")
		}
	}
	return s.SaveSettings(ctx, settings, actorID, restored)
}

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// RestorePlan restores {version, fromVersion} of a plan's history as a new version.
func (s *Subscriptions) RestorePlan(ctx context.Context, planID string, input any, actorID string) (map[string]any, error) {
	in := obj(input)
	from, ok := in["fromVersion"].(string)
	if !ok || !versionPattern.MatchString(from) {
		return nil, apperr.BadRequest("Invalid plan version")
	}
	previous, err := s.store.Get(ctx, "SUB_PLAN_HISTORY#"+planID, from)
	if err != nil {
		return nil, err
	}
	if previous == nil {
		return nil, apperr.NotFound("Plan version not found")
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	if v, ok := in["version"].(float64); !ok || v != settings["version"] {
		return nil, apperr.Conflict()
	}
	values := settings["values"].(map[string]any)
	plans := list(values["plans"])
	found := false
	for i, p := range plans {
		plan := obj(p)
		if plan["id"] == planID {
			found = true
			plans[i] = spread(previous.Data, map[string]any{"id": planID, "enabled": plan["enabled"], "archived": plan["archived"]})
		}
	}
	if !found {
		return nil, apperr.NotFound("Plan not found")
	}
	return s.SaveSettings(ctx, settings, actorID, &Restored{ID: planID, Version: from})
}

// PriceLink attaches Stripe ids created elsewhere to a plan. ProductID and PriceID are the
// String() of the given values (JavaScript regex tests coerce).
type PriceLink struct {
	PlanID    string
	ProductID string
	PriceID   string
}

var (
	productPattern = regexp.MustCompile(`^prod_[A-Za-z0-9]{1,250}$`)
	pricePattern   = regexp.MustCompile(`^price_[A-Za-z0-9]{1,250}$`)
)

// LinkStripePrices attaches Stripe ids to plans (in links order) without new versions and
// returns the ids of the plans that changed.
func (s *Subscriptions) LinkStripePrices(ctx context.Context, links []PriceLink, actorID string) ([]string, error) {
	old, err := s.store.Get(ctx, "SUB_CONFIG", "settings")
	if err != nil {
		return nil, err
	}
	oldData := rowData(old)
	if truthy(oldData["catalogOperation"]) {
		return nil, apperr.New(409, "Resume the pending Stripe synchronization before linking prices")
	}
	plans := list(cloneJSON(oldData["plans"]))
	if oldData["plans"] == nil {
		plans = list(Defaults()["plans"])
	}
	byPlan := map[string]PriceLink{}
	for _, link := range links {
		exists := false
		for _, p := range plans {
			if obj(p)["id"] == link.PlanID {
				exists = true
			}
		}
		if !exists {
			return nil, apperr.NotFound("Plan not found: " + link.PlanID)
		}
		if !productPattern.MatchString(link.ProductID) || !pricePattern.MatchString(link.PriceID) {
			return nil, apperr.BadRequest("Invalid Stripe ids for " + link.PlanID)
		}
		byPlan[link.PlanID] = link
	}
	linked := []string{}
	taken := map[string]bool{}
	for _, p := range plans {
		plan := obj(p)
		planID := jsString(plan["id"])
		link, has := byPlan[planID]
		if has && (plan["stripePriceId"] != link.PriceID || plan["stripeProductId"] != link.ProductID) {
			linked = append(linked, planID)
		}
		if !has && truthy(plan["stripePriceId"]) {
			taken[jsString(plan["stripePriceId"])] = true
		}
	}
	if len(linked) == 0 {
		return linked, nil
	}
	prices := map[string]bool{}
	for _, link := range byPlan {
		prices[link.PriceID] = true
	}
	for _, planID := range linked {
		if taken[byPlan[planID].PriceID] {
			return nil, apperr.BadRequest("A Stripe price can belong to one plan only")
		}
	}
	if len(prices) != len(byPlan) {
		return nil, apperr.BadRequest("A Stripe price can belong to one plan only")
	}
	next := make([]any, len(plans))
	for i, p := range plans {
		plan := obj(p)
		if link, has := byPlan[jsString(plan["id"])]; has {
			next[i] = spread(plan, map[string]any{"stripeProductId": link.ProductID, "stripePriceId": link.PriceID})
		} else {
			next[i] = plan
		}
	}
	base := cloneMap(oldData)
	if old == nil {
		base = Defaults()
	}
	err = s.store.Transact(ctx, []nosql.Write{
		write(old, "SUB_CONFIG", "settings", spread(base, map[string]any{"plans": next})),
		s.audit(map[string]any{"action": "link-stripe-prices", "plans": toJSON(linked), "actorId": actorID, "at": s.now()}),
	})
	if err != nil {
		return nil, err
	}
	return linked, nil
}

// PublishPlan publishes a saved plan through the catalog, persisting the operation first so
// a failure can be resumed ({version, secretKey?}).
func (s *Subscriptions) PublishPlan(ctx context.Context, planID string, input any, actorID string) (map[string]any, error) {
	if s.catalog == nil {
		return nil, apperr.New(503, "Stripe catalog is not configured")
	}
	in := obj(input)
	secret, _ := in["secretKey"].(string)
	publisher := s.catalog(secret)
	row, err := s.store.Get(ctx, "SUB_CONFIG", "settings")
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apperr.New(409, "Save your plans first")
	}
	operation := obj(row.Data["catalogOperation"])
	if operation != nil && operation["planId"] != planID {
		return nil, apperr.New(409, "Resume the pending plan synchronization first")
	}
	if operation == nil {
		if v, ok := in["version"].(float64); !ok || v != float64(row.Version) {
			return nil, apperr.Conflict()
		}
		var plan map[string]any
		for _, p := range list(row.Data["plans"]) {
			if obj(p)["id"] == planID {
				plan = obj(p)
				break
			}
		}
		if plan == nil {
			return nil, apperr.NotFound("Plan not found")
		}
		last, err := s.store.Get(ctx, "SUB_CATALOG_LAST", planID)
		if err != nil {
			return nil, err
		}
		operation = map[string]any{"id": s.newID(), "planId": planID, "plan": plan, "previous": rowData(last)["plan"], "actorId": actorID, "at": s.now()}
		namespace := row.Data["catalogNamespace"]
		if namespace == nil {
			namespace = s.newID()
		}
		if err := s.store.Transact(ctx, []nosql.Write{write(row, "SUB_CONFIG", "settings", spread(row.Data, map[string]any{"catalogNamespace": namespace, "catalogOperation": operation}))}); err != nil {
			return nil, err
		}
		if row, err = s.store.Get(ctx, "SUB_CONFIG", "settings"); err != nil {
			return nil, err
		}
	}
	result, err := publisher.Publish(ctx, obj(operation["plan"]), jsString(row.Data["catalogNamespace"]), obj(operation["previous"]))
	if err != nil {
		return nil, err
	}
	current, err := s.store.Get(ctx, "SUB_CONFIG", "settings")
	if err != nil {
		return nil, err
	}
	pending := obj(current.Data["catalogOperation"])
	if pending == nil {
		return s.Settings(ctx)
	}
	if pending["id"] != operation["id"] {
		return nil, apperr.Conflict()
	}
	plan := spread(obj(operation["plan"]), map[string]any{"stripePriceId": result.StripePriceID, "stripeProductId": result.StripeProductID, "stripeManaged": true})
	last, err := s.store.Get(ctx, "SUB_CATALOG_LAST", planID)
	if err != nil {
		return nil, err
	}
	price, err := s.store.Get(ctx, "SUB_PLAN_PRICES", result.StripePriceID)
	if err != nil {
		return nil, err
	}
	plans := list(current.Data["plans"])
	next := make([]any, len(plans))
	for i, p := range plans {
		if obj(p)["id"] == planID {
			next[i] = plan
		} else {
			next[i] = p
		}
	}
	data := spread(current.Data, map[string]any{"plans": next})
	delete(data, "catalogOperation")
	err = s.store.Transact(ctx, []nosql.Write{
		write(current, "SUB_CONFIG", "settings", data),
		write(last, "SUB_CATALOG_LAST", planID, map[string]any{"plan": plan}),
		write(price, "SUB_PLAN_PRICES", result.StripePriceID, map[string]any{"plan": plan}),
		s.audit(map[string]any{"action": "publish-plan", "planId": planID, "version": plan["version"], "actorId": actorID, "at": s.now()}),
	})
	if err != nil {
		return nil, err
	}
	return s.Settings(ctx)
}
