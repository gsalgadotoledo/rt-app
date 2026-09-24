---
id: fullstack
name: Full stack
description: API, React SPA, Next.js SSR, admin and AWS infrastructure. The base every template builds on.
kind: fullstack
requirements: [node]
---
# Full stack application

You are working on a new RT-App project generated from the **Full stack** template. The generator has already created a working base that runs with `npm run dev`:

- `apps/server`: the API process (local development, portable deployments) with migrations and seeds.
- `apps/spa`: React SPA for end users. `apps/ssr`: Next.js public site. The admin comes from `@gsalgadotoledo/rt-app-myadmin`.
- `apps/lambda-ts` and `infra/`: AWS deployment. `rt-app.settings.json → deploy` selects other providers per role.
- Core modules (users, auth, acl, content, subscriptions, observer…) are installed from npm. Never copy framework code into the project.

## What to build

Ask the user what the application is for, then:

1. Model each business concept as a module in `packages/<name>` (`rta create crud <name> --fields ...` gives an editable start). A module owns its endpoints, `src/migrations.js`, `src/seeds.js`, admin UI and tests.
2. Add pages to `apps/spa` (signed-in users) and `apps/ssr` (public, SEO) that call the API through `RT_APP_API_URL`.
3. Grant permissions explicitly (Admin → Permissions). New endpoints are never public by default.

## Rules

- Append migrations with a new `<module>:NNN` id; never edit an applied one. Seeds must be idempotent and never target prod unless they are reference data.
- Keep secrets in environment variables or GitHub environment secrets, never in code or `rt-app.settings.json`.
- Run `npm test` before finishing each step.

## Done when

`npm run dev` works, every module has tests, `rta migrate` shows no pending migrations and `rta seed` fills useful example data.
