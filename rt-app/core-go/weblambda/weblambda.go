// Package weblambda runs an http.Handler (such as web.App) on AWS Lambda behind API Gateway,
// with the official github.com/aws/aws-lambda-go library.
//
// HTTP APIs (payload format 2.0) and REST APIs / payload format 1.0 are both accepted:
//
//	func main() { weblambda.Start(app) }
//
// LocalBridge serves the same Lambda function over local HTTP, so HTTP contracts can
// validate Lambda mode without AWS.
package weblambda

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"rt.local/core-go/web"
)

// Function is a Lambda function: a raw event in, a JSON-encodable response out.
type Function func(ctx context.Context, event json.RawMessage) (any, error)

// ErrUnsupportedEvent is returned for events that are not API Gateway HTTP events.
var ErrUnsupportedEvent = errors.New("weblambda: unsupported event (expected API Gateway v1 or v2)")

// Start runs handler as the Lambda function of this process. It never returns.
func Start(handler http.Handler) { lambda.Start(Handler(handler)) }

// Handler returns the Lambda function for handler. It detects the payload version:
// v2 events answer events.APIGatewayV2HTTPResponse, v1 events events.APIGatewayProxyResponse.
func Handler(handler http.Handler) Function {
	return func(ctx context.Context, event json.RawMessage) (any, error) {
		var probe struct {
			Version        string `json:"version"`
			HTTPMethod     string `json:"httpMethod"`
			RequestContext struct {
				HTTP *struct{} `json:"http"`
			} `json:"requestContext"`
		}
		if err := json.Unmarshal(event, &probe); err != nil {
			return nil, err
		}
		switch {
		case probe.Version == "2.0" || probe.RequestContext.HTTP != nil:
			var request events.APIGatewayV2HTTPRequest
			if err := json.Unmarshal(event, &request); err != nil {
				return nil, err
			}
			return ServeV2(ctx, handler, request)
		case probe.HTTPMethod != "":
			var request events.APIGatewayProxyRequest
			if err := json.Unmarshal(event, &request); err != nil {
				return nil, err
			}
			return ServeV1(ctx, handler, request)
		default:
			return nil, ErrUnsupportedEvent
		}
	}
}

// ServeV2 handles an HTTP API (payload format 2.0) event.
func ServeV2(ctx context.Context, handler http.Handler, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	body, err := decodeBody(event.Body, event.IsBase64Encoded)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	method := event.RequestContext.HTTP.Method
	path := event.RawPath
	if path == "" {
		path = event.RequestContext.HTTP.Path
	}
	target := path
	if event.RawQueryString != "" {
		target += "?" + event.RawQueryString
	}
	r, err := web.NewRequest(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	for name, value := range event.Headers {
		r.Header.Set(name, value)
	}
	if len(event.Cookies) > 0 {
		r.Header.Set("Cookie", strings.Join(event.Cookies, "; "))
	}
	finish(r, event.RequestContext.HTTP.SourceIP, len(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)

	result := recorder.Result()
	response := events.APIGatewayV2HTTPResponse{StatusCode: result.StatusCode, Headers: map[string]string{}}
	for name, values := range result.Header {
		if name == "Set-Cookie" {
			response.Cookies = values
			continue
		}
		response.Headers[name] = strings.Join(values, ",")
	}
	response.Body, response.IsBase64Encoded = encodeBody(recorder.Body.Bytes())
	return response, nil
}

// ServeV1 handles a REST API (payload format 1.0) event.
func ServeV1(ctx context.Context, handler http.Handler, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	body, err := decodeBody(event.Body, event.IsBase64Encoded)
	if err != nil {
		return events.APIGatewayProxyResponse{}, err
	}
	query := url.Values{}
	if len(event.MultiValueQueryStringParameters) > 0 {
		for name, values := range event.MultiValueQueryStringParameters {
			query[name] = values
		}
	} else {
		for name, value := range event.QueryStringParameters {
			query.Set(name, value)
		}
	}
	target := event.Path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	r, err := web.NewRequest(ctx, event.HTTPMethod, target, bytes.NewReader(body))
	if err != nil {
		return events.APIGatewayProxyResponse{}, err
	}
	if len(event.MultiValueHeaders) > 0 {
		for name, values := range event.MultiValueHeaders {
			for _, value := range values {
				r.Header.Add(name, value)
			}
		}
	} else {
		for name, value := range event.Headers {
			r.Header.Set(name, value)
		}
	}
	finish(r, event.RequestContext.Identity.SourceIP, len(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, r)

	result := recorder.Result()
	response := events.APIGatewayProxyResponse{
		StatusCode:        result.StatusCode,
		Headers:           map[string]string{},
		MultiValueHeaders: map[string][]string{},
	}
	for name, values := range result.Header {
		response.Headers[name] = values[len(values)-1]
		response.MultiValueHeaders[name] = values
	}
	response.Body, response.IsBase64Encoded = encodeBody(recorder.Body.Bytes())
	return response, nil
}

func finish(r *http.Request, sourceIP string, length int) {
	r.ContentLength = int64(length)
	r.Host = r.Header.Get("Host")
	if sourceIP != "" {
		r.RemoteAddr = sourceIP + ":0"
	}
}

func decodeBody(body string, isBase64 bool) ([]byte, error) {
	if isBase64 {
		return base64.StdEncoding.DecodeString(body)
	}
	return []byte(body), nil
}

// encodeBody returns text bodies as-is and binary bodies as base64.
func encodeBody(body []byte) (string, bool) {
	if utf8.Valid(body) {
		return string(body), false
	}
	return base64.StdEncoding.EncodeToString(body), true
}
