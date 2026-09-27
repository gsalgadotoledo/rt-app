# Tasks in every language

Contracts: `spec/contracts/tasks.contract.yaml` (module) and `tasks-api.contract.yaml` (HTTP,
local mode). Hosts: `spec/hosts/node/documents.mjs`, `spec/hosts/python/documents.py`,
`core-go/cmd/contract-host/documents.go`. Ports: `rt_app.tasks` (Python) and
`rt.local/core-go/tasks` (Go). The contract descriptions hold the full rules.

## Surface and clock

`tasksFeature(store, {now}?)` takes an optional clock (a `FeatureContext`-compatible
`{now(): Date}`; the system clock when omitted), so it is also a `FeatureFactory`. Ports inject it
the same way: `Tasks(store, now=clock)` in Python, `tasks.New(store, tasks.WithClock(now))` in Go.
Both also accept an id generator (`new_id=` / `tasks.WithIDs`) for tests; the default is a random
UUID v4 like `crypto.randomUUID()`.

| Endpoint | Access | Resource | Python | Go |
| --- | --- | --- | --- | --- |
| `GET /tasks` | authenticated | `tasks.mine` | `list(query, actor)` | `List(ctx, q, actor, false)` |
| `GET /tasks/admin` | permission | `tasks.list` | `list(query, actor, everyone=True)` | `List(ctx, q, actor, true)` |
| `POST /tasks` | authenticated | `tasks.create` | `create(body, actor)` | `Create` |
| `PATCH /tasks/:id` | authenticated | `tasks.edit` | `update(id, body, actor)` | `Update` |
| `DELETE /tasks/:id` | authenticated | `tasks.delete` | `remove(id, actor)` | `Remove` |
| `POST /tasks/:id/restore` | authenticated | `tasks.restore` | `restore(id, actor)` | `Restore` |
| `PATCH /tasks/admin/:id` | permission | `tasks.manage` | `update` | `Update` |
| `DELETE /tasks/admin/:id` | permission | `tasks.remove` | `admin_remove(id, actor)` | `AdminRemove` |
| `POST /tasks/admin/:id/restore` | permission | `tasks.restore` | `restore` | `Restore` |

The endpoint list keeps the reference order (restore routes first). Module data: `ADMIN`/`Admin()`,
`MIGRATIONS`/`Migrations` + `migrate`, `SEEDS`/`Seeds` + `welcome_rows(users, at)`/`WelcomeRows`.

**Contract subject `tasks`.** `init: {rows, now}`. Methods (actors are `{id, role, grants}`):
`list(query, actor)`, `listAll(query, actor)`, `create(body, actor)`, `update(id, body, actor)`,
`remove(id, actor)`, `restore(id, actor)`, `manage(id, body, actor)`, `adminRemove(id, actor)`,
`adminRestore(id, actor)`; helpers `endpoints()`, `admin()`, `migrations()`, `migrate()`,
`seeds()`, `seedRows(users)`, `row(pk, sk)` and `setNow(iso)`.

## Semantics ports must copy

- **Create:** `text(body.title, "title", 200)`; data `{id, title, done: false, ownerId}` plus the
  audit create fields; only the title is read from the body. Returns the data (no version).
- **Lists** use the shared `searchPage` (`search_page` / `users.SearchPage`) with filters
  `id, title, done, ownerId`: `trash` other than `"true"`/`"false"` is 400 `Invalid trash filter`
  (checked first), other names are 400 `Unsupported filter: <name>`, a foreign cursor is 400
  `Invalid cursor`. Filters are case-insensitive substrings of `String(value)` (JavaScript
  `toLowerCase`, so `ΟΔΟΣ` matches `δος`), empty values are ignored. At most 10 store pages are
  read; the first page with matches is returned with the store cursor.
- **Edits**, in order: missing row or wrong state (live for update/remove, deleted for restore,
  by JavaScript truthiness of `deletedAt`: `""` is live, `[]` is deleted) → 404 `Task not found`;
  not the task owner, not role `owner` and no `tasks.manage` grant → 403
  `This task belongs to another user`; merge the audit fields; update only: a present `title`
  (`null` included) is validated, then a present `done` must be a boolean (400
  `done must be a boolean`). The row is rewritten with version + 1, guarded by the read version,
  keeping `ttl` and unknown data fields. `remove` returns `{ok: true}`.
- **`adminRemove`** first requires role `owner` or `tasks.manage` (403 `Requires tasks.manage`),
  before the lookup, even for the task's own owner.
- **Audit:** `auditUpdate` → `{updatedAt, updatedBy}`; `auditDelete` adds `deletedAt/By` (same
  instant); `auditRestore` clears them and sets `restoredAt/By` (kept after later edits).
- **Seed** `tasks:welcome` (local, develop, stage): one row per demo user,
  `{pk: TASKS, sk: welcome-<id>, data: {id, title: "Explore my first task in RT-App", done: false,
  ownerId, createdAt}}`, inserted only when missing. The TypeScript seed reads the system clock.
- **Migration** `tasks:001` (`tasks-document-v1`) writes `SCHEMA/tasks {schemaVersion: 1}` once.

## HTTP (local mode)

Local mode has no session authenticator, so every personal endpoint answers 401 `Sign in`
(including `DELETE /tasks/admin`, which matches `/tasks/:id`) and tasks cannot be created over
HTTP. The admin endpoints under `/admin/app/tasks/admin…` run as the local owner. The TypeScript
framework also serves permission endpoints at their plain path for signed-in actors; the Python and
Go web layers do not, so that is not pinned.
