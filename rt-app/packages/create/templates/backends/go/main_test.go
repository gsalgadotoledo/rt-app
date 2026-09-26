package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"rt.local/core-go/web"
)

func TestNativeRoutesAndCLI(t *testing.T) {
	c := Compose(context.Background(), true)
	defer c.Close()
	app, err := c.App.Get()
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{"/hello": `"language":"go"`, "/health/live": `"ok":true`} {
		var out, errs bytes.Buffer
		if code := web.RunCLI(app, []string{"GET", path}, &out, &errs); code != 0 || !strings.Contains(out.String(), want) {
			t.Fatalf("%s: exit %d, %s %s", path, code, out.String(), errs.String())
		}
	}
	var out, errs bytes.Buffer
	if code := web.RunCLI(app, []string{"GET", "/nope"}, &out, &errs); code != 1 {
		t.Fatalf("unknown route without a core: exit %d", code)
	}
}
