package migrations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"rt.local/core-go/internal/js"
)

// Usage lines of the migrate and seed commands (also the error of malformed arguments).
const (
	MigrateUsage = "Usage: rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]"
	SeedUsage    = "Usage: rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]"
)

// RunnerOptions are what a command passes when it builds a runner.
type RunnerOptions struct {
	Log     func(string)
	Secrets map[string]string
}

// App is what the migrate and seed commands need from an application.
type App interface {
	Environment() string
	Migrations(RunnerOptions) (*Runner, error)
	Seeds(RunnerOptions) (*SeedRunner, error)
}

type app struct{ options Options }

// NewApp returns an App over a store and its modules; options.Log and options.Secrets are
// replaced by what each command passes.
func NewApp(options Options) App { return &app{options: options} }

func (a *app) Environment() string {
	if a.options.Environment == "" {
		return "local"
	}
	return a.options.Environment
}

func (a *app) Migrations(o RunnerOptions) (*Runner, error) {
	options := a.options
	options.Log = o.Log
	return NewRunner(options)
}

func (a *app) Seeds(o RunnerOptions) (*SeedRunner, error) {
	options := a.options
	options.Log, options.Secrets = o.Log, o.Secrets
	return NewSeedRunner(options)
}

type flags struct {
	values map[string]string
	bools  map[string]bool
}

// parse reads [action] then --name flags; boolean flags are listed so typos fail.
func parse(argv, valueFlags, booleanFlags []string, usage string) (string, flags, error) {
	f := flags{values: map[string]string{}, bools: map[string]bool{}}
	action, rest := "", argv
	if len(argv) > 0 && argv[0] != "" && !strings.HasPrefix(argv[0], "--") {
		action, rest = argv[0], argv[1:]
	}
	has := func(list []string, name string) bool {
		for _, item := range list {
			if item == name {
				return true
			}
		}
		return false
	}
	for i := 0; i < len(rest); i++ {
		if !strings.HasPrefix(rest[i], "--") {
			return "", f, errors.New(usage)
		}
		name := rest[i][2:]
		switch {
		case has(booleanFlags, name):
			f.bools[name] = true
		case has(valueFlags, name) && i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "--"):
			i++
			f.values[name] = rest[i]
		default:
			return "", f, errors.New(usage)
		}
	}
	return action, f, nil
}

var (
	decimalNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	radixNumber   = regexp.MustCompile(`^0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

// Number is JavaScript Number(text): trimmed, "" is 0, decimal literals, 0x/0o/0b integers,
// ±Infinity; anything else is NaN.
func Number(text string) float64 {
	t := js.Trim(text)
	switch t {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if m := radixNumber.FindStringSubmatch(t); m != nil {
		base := map[byte]float64{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[m[1][0]]
		n := 0.0
		for _, d := range m[1][1:] {
			v, _ := strconv.ParseInt(string(d), 16, 64)
			n = n*base + float64(v)
		}
		return n
	}
	if !decimalNumber.MatchString(t) {
		return math.NaN()
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return n
}

// step reads --step: an integer >= 0 as JavaScript Number() reads it.
func step(value, usage string) (*int, error) {
	n := Number(value)
	if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 0 {
		return nil, errors.New(usage)
	}
	out := int(min(n, float64(math.MaxInt32)))
	return &out, nil
}

// jsonText is JSON.stringify(value) (indent "" for compact output): no HTML escaping, and
// U+2028/U+2029 are written as they are.
func jsonText(value any, indent string) string {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if indent != "" {
		encoder.SetIndent("", indent)
	}
	_ = encoder.Encode(value)
	raw := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	var out bytes.Buffer
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if raw[i+1] == 'u' && i+5 < len(raw) && (string(raw[i+2:i+6]) == "2028" || string(raw[i+2:i+6]) == "2029") {
				if raw[i+5] == '8' {
					out.WriteString("\u2028")
				} else {
					out.WriteString("\u2029")
				}
				i += 5
				continue
			}
			out.Write(raw[i : i+2])
			i++
			continue
		}
		out.WriteByte(raw[i])
	}
	return out.String()
}

func jsonString(s string) string { return jsonText(s, "") }

func padEnd(s string, n int) string {
	if pad := n - js.Len(s); pad > 0 {
		return s + strings.Repeat(" ", pad)
	}
	return s
}

// MigrateCommand is `rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]`: status by
// default. Output goes to out; malformed arguments return an error with MigrateUsage.
func MigrateCommand(ctx context.Context, a App, argv []string, out func(string)) error {
	action, f, err := parse(argv, []string{"to", "step"}, []string{"json"}, MigrateUsage)
	if err != nil {
		return err
	}
	asJSON := f.bools["json"]
	log := func(line string) { out("  " + line) }
	if asJSON {
		log = func(string) {}
	}
	runner, err := a.Migrations(RunnerOptions{Log: log})
	if err != nil {
		return err
	}
	var target Target
	to, hasTo := f.values["to"]
	target.To = to
	if value, ok := f.values["step"]; ok {
		if target.Step, err = step(value, MigrateUsage); err != nil {
			return err
		}
	}
	environment := a.Environment()
	if action == "" || action == "status" {
		if (hasTo && to != "") || target.Step != nil {
			return errors.New(MigrateUsage)
		}
		status, err := runner.Status(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			out(jsonText(struct {
				Environment string   `json:"environment"`
				Migrations  []Status `json:"migrations"`
			}{environment, status}, "  "))
			return nil
		}
		out("Migrations (" + environment + "):")
		pending := 0
		for _, m := range status {
			line := "  " + padEnd(m.State, 8) + " " + m.ID
			if m.Description != nil && *m.Description != "" {
				line += " — " + *m.Description
			}
			if js.Truthy(m.AppliedAt) {
				line += " (" + js.String(m.AppliedAt) + ")"
			}
			out(line)
			if m.State == "pending" {
				pending++
			}
		}
		if pending > 0 {
			out(fmt.Sprintf("%d pending. Run: rta migrate up", pending))
		} else {
			out("Up to date.")
		}
		return nil
	}
	if action != "up" && action != "down" {
		return errors.New(MigrateUsage)
	}
	var ids []string
	if action == "up" {
		ids, err = runner.Up(ctx, target)
	} else {
		ids, err = runner.Down(ctx, target)
	}
	if err != nil {
		return err
	}
	if asJSON {
		if action == "up" {
			out(jsonText(struct {
				Environment string   `json:"environment"`
				Applied     []string `json:"applied"`
			}{environment, ids}, ""))
		} else {
			out(jsonText(struct {
				Environment string   `json:"environment"`
				Reverted    []string `json:"reverted"`
			}{environment, ids}, ""))
		}
		return nil
	}
	switch {
	case len(ids) > 0 && action == "up":
		out("Applied: " + strings.Join(ids, ", "))
	case len(ids) > 0:
		out("Reverted: " + strings.Join(ids, ", "))
	case action == "up":
		out("Nothing to apply.")
	default:
		out("Nothing to revert.")
	}
	return nil
}

// SeedCommand is `rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]`: run by
// default. secrets are what seeds read with Secret (e.g. DEMO_PASSWORD).
func SeedCommand(ctx context.Context, a App, argv []string, secrets map[string]string, out func(string)) error {
	action, f, err := parse(argv, []string{"module"}, []string{"rerun", "json"}, SeedUsage)
	if err != nil {
		return err
	}
	asJSON := f.bools["json"]
	log := func(line string) { out("  " + line) }
	if asJSON {
		log = func(string) {}
	}
	runner, err := a.Seeds(RunnerOptions{Secrets: secrets, Log: log})
	if err != nil {
		return err
	}
	environment := a.Environment()
	module, hasModule := f.values["module"]
	if action == "status" {
		if (hasModule && module != "") || f.bools["rerun"] {
			return errors.New(SeedUsage)
		}
		status, err := runner.Status(ctx)
		if err != nil {
			return err
		}
		if asJSON {
			out(jsonText(struct {
				Environment string       `json:"environment"`
				Seeds       []SeedStatus `json:"seeds"`
			}{environment, status}, "  "))
			return nil
		}
		out("Seeds (" + environment + "):")
		for _, s := range status {
			line := "  " + padEnd(s.State, 8) + " " + s.ID
			if s.Description != nil && *s.Description != "" {
				line += " — " + *s.Description
			}
			out(line)
		}
		return nil
	}
	if action != "" && action != "run" {
		return errors.New(SeedUsage)
	}
	var modules []string
	if hasModule {
		modules = []string{}
		for _, m := range strings.Split(module, ",") {
			if m = js.Trim(m); m != "" {
				modules = append(modules, m)
			}
		}
	}
	ran, err := runner.Run(ctx, RunOptions{Modules: modules, Rerun: f.bools["rerun"]})
	if err != nil {
		return err
	}
	if asJSON {
		out(jsonText(struct {
			Environment string   `json:"environment"`
			Seeded      []string `json:"seeded"`
		}{environment, ran}, ""))
		return nil
	}
	if len(ran) > 0 {
		out("Seeded: " + strings.Join(ran, ", "))
	} else {
		out("No pending seeds for " + environment + ".")
	}
	return nil
}

// RunCLI runs `migrate …` or `seed …` (seeds read DEMO_PASSWORD from the environment) and
// returns the exit code: errors are printed to stderr with code 1.
//
//	os.Exit(migrations.RunCLI(ctx, migrations.NewApp(options), os.Args[1:], os.Stdout, os.Stderr))
func RunCLI(ctx context.Context, a App, args []string, stdout, stderr io.Writer) int {
	out := func(line string) { fmt.Fprintln(stdout, line) }
	var err error
	switch {
	case len(args) > 0 && args[0] == "migrate":
		err = MigrateCommand(ctx, a, args[1:], out)
	case len(args) > 0 && args[0] == "seed":
		secrets := map[string]string{}
		if password, ok := os.LookupEnv("DEMO_PASSWORD"); ok {
			secrets["DEMO_PASSWORD"] = password
		}
		err = SeedCommand(ctx, a, args[1:], secrets, out)
	default:
		err = errors.New("Usage: migrate … | seed …")
	}
	if err != nil {
		fmt.Fprintln(stderr, err.Error())
		return 1
	}
	return 0
}
