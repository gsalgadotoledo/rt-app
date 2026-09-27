# Content (home page) in every language

Contracts: `spec/contracts/content.contract.yaml` (module) and `content-api.contract.yaml` (HTTP,
local mode). Hosts: `spec/hosts/node/documents.mjs`, `spec/hosts/python/documents.py`,
`core-go/cmd/contract-host/documents.go`. Ports: `rt_app.content` (Python) and
`rt.local/core-go/content` (Go). The contract descriptions hold the full rules; this page lists
what a port has to expose and the details that are easy to get wrong.

## Surface

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Build | `contentFeature(store)` | `Content(store).feature()` | `content.New(store).Feature()` |
| Read | handlers only | `settings()`, `home()` | `Settings(ctx)`, `Home(ctx)` |
| Edit | `PUT` handler | `save(body)` | `Save(ctx, body)` |
| Migrations | `feature.migrations` | `MIGRATIONS`, `migrate(store)` | `Migrations`, `Migrate(ctx, store)` |
| Admin manifest | `feature.admin` | `ADMIN` (also `feature().admin`) | `Admin()` |

Endpoints: `GET /` (guest, `content.home`), `GET /content/settings` (permission, `content.read`)
and `PUT /content/settings` (permission, `content.write`).

**Contract subject `content`.** `init: {rows}` seeds a memory store. Methods: `home()`,
`settings()`, `save(body)` (the PUT handler; wire `null` is `{}`), and the helpers `endpoints()`
(`[{method, path, resource, access}]` as registered), `admin()`, `migrations()`
(`[{id, checksum, description}]`), `migrate()` and `row(pk, sk)`.

## Semantics ports must copy

- One row `CONTENT/home`, data exactly `{title, content}`. Without a row, `settings()` is version 0
  with the default values; with a row, `values` is the stored data **as is** (unknown fields
  included) and `home()` copies only `title` and `content`.
- `save(body)` checks, in this order:
  1. `Number.isInteger(body.version)`, else 400 `Version is required` (`true`, `"1"`, `1.5` fail;
     `1e300` passes).
  2. `version === stored version (0 without a row)`, else 409 `Conflict: refresh and try again`.
     This runs **before** the values are validated.
  3. `text(values.title, "title", 120)`, then `text(values.content, "content", 2000)`; a missing,
     `null` or non-object `values` fails on the title.
  4. Write version + 1 guarded by the stored version (`null` when creating), then return the
     settings read back.
- `text()`: a string, not blank after JavaScript `trim()`, at most `max` **UTF-16 units before
  trimming**; the trimmed value is stored. `trim()` removes U+FEFF, NBSP, U+2028/2029, U+3000…,
  but not U+0085 or U+200B. Reuse `rt_app.contracts.text` / `users.Text`.
- Migration `content:001` (`content-document-v1`) writes `SCHEMA/content {schemaVersion: 1}`
  version 1 once and never touches an existing row.

## HTTP (local mode)

`GET /` is public; the settings live under `/admin/app/content/settings` for the local owner.
The home row is shared by the whole server, so the HTTP cases read the current version first.
The TypeScript framework also serves permission endpoints at their plain path for signed-in
actors with the grant (401 `Sign in` without a session); the Python and Go web layers mount them
only under `/admin/app`, so that difference is not pinned.
