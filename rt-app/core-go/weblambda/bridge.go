package weblambda

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"

	"rt.local/core-go/web"
)

// maxPayload is API Gateway's request payload limit for Lambda integrations.
const maxPayload = 6 << 20

// LocalBridge returns an http.Handler that turns each request into an API Gateway v2 event,
// passes it as JSON to fn (as the Lambda runtime would) and writes back the v2 response.
// Serve it with web.Serve to exercise a Lambda function locally.
func LocalBridge(fn Function) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxPayload))
		if err != nil {
			http.Error(w, `{"message":"Request Entity Too Large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		event, err := json.Marshal(toEvent(r, body))
		if err != nil {
			bridgeError(w, err)
			return
		}
		result, err := fn(r.Context(), event)
		if err != nil {
			bridgeError(w, err)
			return
		}
		raw, err := json.Marshal(result)
		if err != nil {
			bridgeError(w, err)
			return
		}
		var response events.APIGatewayV2HTTPResponse
		if err := json.Unmarshal(raw, &response); err != nil {
			bridgeError(w, err)
			return
		}
		payload, err := decodeBody(response.Body, response.IsBase64Encoded)
		if err != nil {
			bridgeError(w, err)
			return
		}
		for name, value := range response.Headers {
			w.Header().Set(name, value)
		}
		for name, values := range response.MultiValueHeaders {
			for _, value := range values {
				w.Header().Add(name, value)
			}
		}
		for _, cookie := range response.Cookies {
			w.Header().Add("Set-Cookie", cookie)
		}
		status := response.StatusCode
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = w.Write(payload)
	})
}

// toEvent builds the payload format 2.0 event API Gateway would send for r.
func toEvent(r *http.Request, body []byte) events.APIGatewayV2HTTPRequest {
	target := web.RawTarget(r)
	path, rawQuery, _ := strings.Cut(target, "?")
	headers := map[string]string{}
	var cookies []string
	for name, values := range r.Header {
		lower := strings.ToLower(name)
		if lower == "cookie" {
			for _, value := range values {
				cookies = append(cookies, strings.Split(value, "; ")...)
			}
			continue
		}
		headers[lower] = strings.Join(values, ",")
	}
	if r.Host != "" {
		headers["host"] = r.Host
	}
	var query map[string]string
	if rawQuery != "" {
		query = map[string]string{}
		for _, pair := range strings.Split(rawQuery, "&") {
			name, value, _ := strings.Cut(pair, "=")
			if previous, ok := query[name]; ok {
				value = previous + "," + value
			}
			query[name] = value
		}
	}
	sourceIP, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		sourceIP = r.RemoteAddr
	}
	now := time.Now().UTC()
	event := events.APIGatewayV2HTTPRequest{
		Version:               "2.0",
		RouteKey:              "$default",
		RawPath:               path,
		RawQueryString:        rawQuery,
		Cookies:               cookies,
		Headers:               headers,
		QueryStringParameters: query,
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			RouteKey:  "$default",
			AccountID: "local",
			Stage:     "$default",
			RequestID: now.Format("20060102T150405.000000000"),
			APIID:     "local",
			Time:      now.Format("02/Jan/2006:15:04:05 -0700"),
			TimeEpoch: now.UnixMilli(),
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method:    r.Method,
				Path:      path,
				Protocol:  r.Proto,
				SourceIP:  sourceIP,
				UserAgent: r.UserAgent(),
			},
		},
	}
	event.Body, event.IsBase64Encoded = encodeBody(body)
	return event
}

func bridgeError(w http.ResponseWriter, err error) {
	slog.Error("weblambda: local bridge", "error", err)
	status := http.StatusInternalServerError
	if errors.Is(err, ErrUnsupportedEvent) {
		status = http.StatusBadGateway
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"message":"Internal Server Error"}`))
}
