package main

import (
	"fmt"
	"log"
	rtcore "rt.local/core-go"
	// Switch this import to examples/adapters/spanish. The consumer stays unchanged.
	adapter "rt.local/core-go/examples/adapters/english"
)

// Consumers define the interface they need. No framework base class is required.
type Greeter interface {
	Hello() string
	Close() error
}
type App struct{ Greeting *rtcore.Singleton[Greeter] }

func NewApp(name string) *App {
	return &App{Greeting: rtcore.New(func() (Greeter, error) { return adapter.New(adapter.WithName(name)) }, rtcore.WithClose(func(g Greeter) error { return g.Close() }))}
}
func main() {
	app := NewApp("RT-App")
	defer func() {
		if err := app.Greeting.Close(); err != nil {
			log.Print(err)
		}
	}()
	greeting, err := app.Greeting.Get()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(greeting.Hello())
}
