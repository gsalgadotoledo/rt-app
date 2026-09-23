package spanish

type Client struct{ name string }
type Option func(*Client)

func WithName(name string) Option { return func(c *Client) { c.name = name } }
func New(options ...Option) (*Client, error) {
	c := &Client{name: "World"}
	for _, option := range options {
		option(c)
	}
	return c, nil
}
func (c *Client) Hello() string { return "Hola, " + c.name }
func (c *Client) Close() error  { return nil }
