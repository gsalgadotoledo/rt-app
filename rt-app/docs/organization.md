# Where things live

## Core vs applications

| What | Where | Git / publication |
| --- | --- | --- |
| **Core** (framework, modules, admin, CLI, generator, starter, Service Manager) | `~/Projects/rt-app` | `github.com/gsalgadotoledo/rt-app` (public, all rights reserved) → npm `@gsalgadotoledo/*` |
| **Applications** created with `npm create @gsalgadotoledo/rt-app <name>` | `~/Desktop/rt-apps/<name>` | One git repo per app (`gh repo create --private --source . --push`), never inside the core |
| **Archive** (legacy monorepo `hello-world-rt-app`, `test10`, `test11`, `test13`, `rt-app-playground`) | `~/Projects/_archive` | Kept for reference; not maintained |

Rules:

- The core is edited only in `~/Projects/rt-app`. Applications never contain a copy of the framework. They install pinned `@gsalgadotoledo/rt-app-*` versions.
- `templates/hello-world` is the starter source. `rt-app/packages/create/starter` is generated from it (`npm run prepare:templates`), so never edit the copy.
- An application's own code is its configuration plus `packages/*` (custom modules and extensions). Everything else comes from npm.

## Published

| Name | Kind | Published version |
| --- | --- | --- |
| `@gsalgadotoledo/create-rt-app` | initializer (`npm create @gsalgadotoledo/rt-app`) | 0.1.0 (first release) |
| `@gsalgadotoledo/rt-app-*` (52 packages) | core libraries, adapters, admin, CLI (`rta`), generator, Service Manager | 0.1.0 (`latest`); 20 of them also exist as 0.1.0-alpha.0 (`next`) |
| `github.com/gsalgadotoledo/rt-app` | core source | `main` |

Not ours: `create-rt-app` (unscoped) on npm belongs to another author. Never document `npx create-rt-app`.

## Release checkpoints

1. Work on a branch in `~/Projects/rt-app`.
2. `npm run release:check`. This runs architecture, build, templates, tests with coverage floors, pack and verify. Verify installs the tarballs into a clean folder, generates an app with the generator and with the initializer, builds and tests it, runs migrations and seeds on a real JSON database, builds the Lambda and validates Terraform (needs Terraform ≥ 1.11, or `TF_CLI_PATH`).
3. Merge to `main` and push.
4. Bump every package to the same version (`x.y.z`, or `x.y.z-beta.n` for `next`), then `npm run release:pack && npm run release:verify && npm run release:publish` with `npm login` done. A version can never be republished.
5. Smoke test: `cd ~/Desktop/rt-apps && npm create @gsalgadotoledo/rt-app smoke-<version>`, then `npm run dev`.

Before a release is published, test unpublished changes in an app by installing the packed tarballs: `npm install ~/Projects/rt-app/artifacts/*.tgz`.
