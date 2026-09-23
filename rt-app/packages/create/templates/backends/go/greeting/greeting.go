// Package greeting is a replaceable application adapter, not a framework base class.
package greeting

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
