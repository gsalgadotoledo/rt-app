package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	rtcore "rt.local/core-go"
	adapter "rtapp/backend/greeting"
	"time"
)

type Greeter interface{ Hello() string }

func main() {
	greeting := rtcore.New(func() (Greeter, error) { return adapter.New(adapter.WithName("Go")) })
	defer greeting.Close()
	upstream, err := url.Parse(os.Getenv("RT_APP_CORE_API_URL"))
	if err != nil || upstream.Scheme != "http" || upstream.Hostname() != "127.0.0.1" || upstream.Port() == "" {
		log.Fatal("Core must be a loopback HTTP service")
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	original := proxy.Director
	proxy.Director = func(r *http.Request) { original(r); r.Host = upstream.Host }
	proxy.Transport = &http.Transport{ResponseHeaderTimeout: 15 * time.Second}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		http.Error(w, "RT-App core is unavailable", 502)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && (r.URL.Path == "/hello" || r.URL.Path == "/health") {
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == "/health" {
				json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			} else {
				g, err := greeting.Get()
				if err != nil {
					http.Error(w, "Greeting unavailable", 500)
					return
				}
				json.NewEncoder(w).Encode(map[string]string{"message": g.Hello(), "language": "go"})
			}
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16384)
		proxy.ServeHTTP(w, r)
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "4010"
	}
	log.Printf("Go API: http://localhost:%s", port)
	server := &http.Server{Addr: "127.0.0.1:" + port, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	log.Fatal(server.ListenAndServe())
}
