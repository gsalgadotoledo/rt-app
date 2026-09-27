package weblambda

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"rt.local/core-go/web"
)

func testApp(t *testing.T) http.Handler {
	t.Helper()
	app, err := web.New([]web.Feature{{ID: "t", Endpoints: []web.Endpoint{
		{Method: "POST", Path: "/echo/:id", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			return map[string]any{"id": c.Params["id"], "body": c.Request.Body, "q": c.Request.Query["q"], "h": c.Request.Headers.Get("X-Test")}, nil
		}},
		{Method: "GET", Path: "/owner", Access: web.Owner, Handle: func(c *web.Context) (any, error) { return c.Actor.ID, nil }},
	}}}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	return app
}

const want = `{"body":{"n":1},"h":"yes","id":"a b","q":"x"}`

func TestV2Event(t *testing.T) {
	event := `{"version":"2.0","routeKey":"$default","rawPath":"/echo/a%20b","rawQueryString":"q=x",
		"headers":{"x-test":"yes","content-type":"application/json"},
		"requestContext":{"http":{"method":"POST","path":"/echo/a b","sourceIp":"1.2.3.4"}},
		"body":"eyJuIjoxfQ==","isBase64Encoded":true}`
	out, err := Handler(testApp(t))(context.Background(), json.RawMessage(event))
	if err != nil {
		t.Fatal(err)
	}
	res, ok := out.(events.APIGatewayV2HTTPResponse)
	if !ok || res.StatusCode != 200 || res.Body != want || res.Headers["Cache-Control"] != "no-store" {
		t.Fatalf("got %#v", out)
	}
}

func TestV1Event(t *testing.T) {
	event := `{"httpMethod":"POST","path":"/echo/a%20b","queryStringParameters":{"q":"x"},
		"headers":{"X-Test":"yes"},"requestContext":{"identity":{"sourceIp":"1.2.3.4"}},"body":"{\"n\":1}"}`
	out, err := Handler(testApp(t))(context.Background(), json.RawMessage(event))
	if err != nil {
		t.Fatal(err)
	}
	res, ok := out.(events.APIGatewayProxyResponse)
	if !ok || res.StatusCode != 200 || res.Body != want || res.MultiValueHeaders["Content-Type"][0] != "application/json" {
		t.Fatalf("got %#v", out)
	}
}

func TestInvalidEscapeAndUnsupportedEvents(t *testing.T) {
	fn := Handler(testApp(t))
	out, err := fn(context.Background(), json.RawMessage(`{"version":"2.0","rawPath":"/echo/%E0%A4%A","requestContext":{"http":{"method":"POST"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if res := out.(events.APIGatewayV2HTTPResponse); res.StatusCode != 400 || res.Body != `{"error":"Invalid URL"}` {
		t.Fatalf("got %#v", res)
	}
	if _, err := fn(context.Background(), json.RawMessage(`{"source":"aws.events"}`)); !errors.Is(err, ErrUnsupportedEvent) {
		t.Fatalf("got %v", err)
	}
}

func TestLocalBridge(t *testing.T) {
	server := httptest.NewServer(LocalBridge(Handler(testApp(t))))
	defer server.Close()
	r, _ := http.NewRequest("POST", server.URL+"/echo/a%20b?q=x", strings.NewReader(`{"n":1}`))
	r.Header.Set("X-Test", "yes")
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != want || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("got %d %s %v", res.StatusCode, body, res.Header)
	}
	res, err = http.Get(server.URL + "/owner")
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 401 || string(body) != `{"error":"Sign in"}` {
		t.Fatalf("owner route at its plain path needs a session: %d %s", res.StatusCode, body)
	}
}
