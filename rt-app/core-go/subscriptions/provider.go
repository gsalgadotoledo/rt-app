package subscriptions

import "context"

// User is the account holder of a billing operation (the TypeScript Actor fields used here).
type User struct {
	ID    string
	Email string
}

// Event is a verified payment webhook event.
type Event struct {
	ID       string
	Type     string
	Customer string
}

// BillingProvider is a payment adapter (TypeScript BillingProvider): LocalBilling here, Stripe
// in a separate module. Results are decoded JSON objects; they are stored and returned as is.
type BillingProvider interface {
	// Mode is "local" or "stripe".
	Mode() string
	// PublishableKey is the browser key ("" when none).
	PublishableKey() string
	Customer(ctx context.Context, user User, key string) (string, error)
	Change(ctx context.Context, customer string, plan Plan, subscriptionID, key string) (map[string]any, error)
	Setup(ctx context.Context, customer, key string) (map[string]any, error)
	SetPaymentMethod(ctx context.Context, customer, setupID, subscriptionID string) error
	Cancel(ctx context.Context, customer, subscriptionID, key string) (map[string]any, error)
	Snapshot(ctx context.Context, customer, subscriptionID string) (map[string]any, error)
	Verify(raw, signature string) (Event, error)
}

// PlanValidator is implemented by providers that check a plan before a paid change.
type PlanValidator interface {
	ValidatePlan(ctx context.Context, plan Plan, customer string) error
}

// Simulator is implemented by providers that can simulate a payment status (LocalBilling).
type Simulator interface {
	Simulate(ctx context.Context, customer, status string) error
}

// CatalogIDs are the Stripe ids of a published plan version.
type CatalogIDs struct {
	StripePriceID   string `json:"stripePriceId"`
	StripeProductID string `json:"stripeProductId"`
}

// CatalogPublisher publishes a plan version to the payment catalog (TypeScript CatalogPublisher).
type CatalogPublisher interface {
	Publish(ctx context.Context, plan Plan, namespace string, previous Plan) (CatalogIDs, error)
}

// Mail is one notification.
type Mail struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Text    string `json:"text"`
}
