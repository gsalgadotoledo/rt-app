// Package greeting is a replaceable application adapter, not a framework base class.
package greeting

import "rt.local/core-go/web"

type Client struct{ name string }
type Option func(*Client)

func WithName(name string) Option { return func(c *Client) { c.name = name } }
func New(options ...Option) (*Client, error) {
	c := &Client{name: "Go"}
	for _, option := range options {
		option(c)
	}
	return c, nil
}
func (c *Client) Hello() string { return "Hello from " + c.name }

// Feature exposes the module over HTTP: GET /hello for everyone.
func (c *Client) Feature() web.Feature {
	return web.Feature{ID: "greeting", Endpoints: []web.Endpoint{{
		Method: "GET", Path: "/hello", Access: "guest", Resource: "greeting",
		Handle: func(*web.Context) (any, error) {
			return map[string]string{"message": c.Hello(), "language": "go"}, nil
		},
	}}}
}
