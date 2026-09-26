# @gsalgadotoledo/rt-app-conformance

Contracts for RT-App modules, independent of the language they are written in. A contract is
a YAML or JSON file with the inputs, expected outputs and errors of a module, and every
implementation must pass it. Implementations exist in TypeScript, Python and Go.

```yaml
contract: 1
module: feature-flags
init: { rows: [] }                    # values used to build each case's instance
cases:
  - name: keys must be lowercase identifiers
    tags: [edge]
    steps:
      - { call: get, args: [Bad Key], expect: { error: { status: 400, message: Invalid flag key } } }
      - { call: get, args: [a.b_c-d9], expect: { value: null } }
```

- **Hosts:** each language runs a *contract host*, a small loopback HTTP server. It creates
  real instances with `init` and calls their methods with typed arguments (host protocol v1).
  Internal methods can be tested too.
- **HTTP contracts:** `kind: http` contracts test a running API instead: requests plus the
  expected status, body and headers.
- **Matchers:** `$any`, `$type`, `$regex`, `$approx`, `$partial`, `$length`, `$oneOf`.
- **Macros:** `$ref` (the result of an earlier step), `$repeat`, `$text`.
- **Recording:** `--record` fills in outputs from the reference implementation.

```sh
rta-contract show  --config rt-app/spec/contracts.json            # read the cases as a table
rta-contract test  --config rt-app/spec/contracts.json            # every language in the config
rta-contract test  --config rt-app/spec/contracts.json --target python --filter edge
rta-contract test  --config rt-app/spec/contracts.json --record   # record on the reference target
```

For the format, the protocol and the semantics that ports must match, see
`rt-app/docs/polyglot.md`.
