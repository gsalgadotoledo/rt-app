# Test users: contracts and ports

Contracts: `spec/contracts/users.contract.yaml` (module, subject `users`, cases tagged `test-users`)
and `users-test-flag-api.contract.yaml` (HTTP). Reference: `packages/users/src/test-users.ts` (reader,
validators, `testUserIds`), `Users.create` / `Users.update` and the list endpoint in
`packages/users/src/index.ts`, `viewAccount` in `packages/users/src/suspension.ts`. Ports:
`rt_app.users` (Python) and `rt.local/core-go/users` (Go). User guide: `docs/authentication.md`
"Test users".

## Design

- **A label on the user row, not a new identity or role.** `USERS/<id>.data.testUser`, like
  `data.ban`. It never changes sign-in, sessions (`tokenVersion`), bans, ACL grants or credits; it
  exists so reports and lists can separate QA, demo and internal traffic from customers.
- **Strict reader.** Only the boolean `true` marks a test user. A missing field, `false`, `"true"`,
  `1` or anything else is a real user (JavaScript `=== true`; Python `is True`; Go `.(bool)`).
- **Administrators only.** The flag is accepted by `POST /users` (`users.create`) and
  `PATCH /users/:id` (`users.edit`, which still requires an owner to edit an owner). `PATCH /users/me`
  keeps its rule "only name" (400 `Only name can be edited; email requires verification`), so a
  user cannot change its own flag. `bootstrapOwner` drops `testUser` without validating it: the first
  owner is never a test user.
- **Storage.** `create` stores `testUser: true` only when true (nothing for false, so existing rows
  and the create contract are unchanged). `update` stores the given boolean, `true` or `false`.

## Rows

```text
USERS/<id>   data.testUser = true | false | (missing)      only true is a test user
```

`update` is one conditional write: the user row with `version + 1`, `expected` = the version read,
the given fields and `updatedAt`/`updatedBy`. A version conflict is the store's 409.

## Validation

**create** `{email, name, password, testUser?}`: email, name and password as before, then
`testUser`: `undefined`/`null` = not given; otherwise a boolean or 400 `Invalid field: testUser`.
Nothing is stored on any error.

**update** `(id, {name?, testUser?}, actor)`, in order:

| Step | Rule | Error |
| --- | --- | --- |
| user | exists and not deleted | 404 `User not found` |
| keys | only `name` and `testUser` (a key with a null value still counts) | 400 `Only name and testUser can be edited; email requires verification` |
| name | validated when `name` is not null, or when `testUser` is null/missing (so `{}` fails here) | 400 `Invalid field: name` |
| testUser | null = not given; otherwise a boolean | 400 `Invalid field: testUser` |

**list** `GET /users`: `?testUser` is checked before any other filter: absent, `""` (no filter),
`"true"` or `"false"`; anything else is 400 `Invalid testUser filter`. Then it filters on the view's
`testUser` like every other field (`String(value)` contains the query, case-insensitively).

## Views

The **admin user view** (`GET /users`, `GET /users/:id`, `POST /users`, `PATCH /users/:id`, ban and
unban) is the user view plus `banned`, `ban` and `testUser` (boolean). `POST /users` and
`PATCH /users/:id` returned the plain user view before 0.3.0; the admin view is a superset.
`GET /users/me` and the auth responses keep the plain user view (no `testUser`).

## Ports

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Reader | `isTestUser(data)` | `is_test_user(data)` | `users.IsTestUser(data)` |
| Validators | `testUserInput`, `testUserFilter` | `test_user_input`, `test_user_filter` | `TestUserInput`, `TestUserFilter` |
| Admin edit | `users.update(id, input, actor)` | `users.update(id, input, actor)` | `(*Users).Update(ctx, id, input, actor)` |
| Report helper | `testUserIds(store)` → `Set` | `test_user_ids(store)` → `set` | `TestUserIDs(ctx, store)` → sorted `[]string` |

`testUserIds` reads the whole `USERS` partition page by page and includes deleted test users (their
past usage is still test traffic). Python test files import these helpers through the module
(`users_module.test_user_ids`): names starting with `test_` imported into a test module would be
collected by pytest.

## Facade (subject `users`)

Added methods: `update(id, input, actor)`, `view(id)` (GET /users/:id), `list(query)` (GET /users),
`isTestUser(data)` and `testUserIds()` (sorted by code point).
