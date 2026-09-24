# Roadmap (proposal, pending approval)

Each phase ends with a published, verified checkpoint (see organization.md).

## 0.1.0: checkpoint (current)

Module migrations and seeds (Umzug), credit ledger with weekly allowance, top-ups, rates and sandbox, subscriptions overview, trash confirmation, starter with shared data application, `npm create @gsalgadotoledo/rt-app`.

## 0.2.0: declarative templates, slim applications

**Templates as Markdown.** A template is one `template.md`: YAML front matter for the machine-readable part, and a Markdown body for humans and agents. The generator reads it, and the Service Manager lists templates from these files. A template stops being a copied tree of code, so it cannot go stale.

```md
---
id: saas-credits
name: SaaS with credits
backend: node-ts
modules: [users, auth, acl, content, subscriptions]
crud:
  - name: projects
    fields: { name: string, budget: number?, archived: boolean }
    actions: [archive]
extensions:
  subscriptions: { plans: ./plans.json }
apps: [spa, ssr, admin]
---
# SaaS with credits
What it is, how to extend it, rules for agents…
```

**Slim applications.** The server, Lambda, MCP, SPA and SSR entry points move from copied files into core packages. An application then contains:

```
rt-app.md          ← the app itself: modules, settings, environments (replaces modules.json + rt-app.settings.json)
packages/          ← custom modules and extensions of core modules
apps/spa|ssr       ← only if the app customizes its UI (optional)
infra/             ← only overrides
.github/workflows  ← generated, calls reusable workflows from the core
```

Upgrading the framework becomes `npm update`, with no merges of copied code. An extension of a core module is a package that wraps its Feature (endpoints, migrations, seeds, admin) through a documented extension API instead of forking it.

## 0.3.0: GitHub from the start

`rta github connect` creates or links the repo. It creates the `develop`, `stage` and `prod` environments with their variables and secrets, protects `main`, and installs the deploy workflow. A merge into `develop`, `stage` or `main` deploys that environment. The Service Manager shows the same flow with buttons. Deployment stays disabled until a target is configured.

## 0.4.0: deploy targets per role

The provider is chosen per **role** and per environment, from the admin or `rt-app.md`. Each provider is one package, `@gsalgadotoledo/rt-app-deploy-<provider>`, that implements the roles it supports behind one contract: `plan`, `apply`, `status`, `logs`, `destroy`, plus the secrets it needs. Credentials are API keys stored as GitHub environment secrets, never in the database.

| Role | Providers (package per provider) |
| --- | --- |
| **API** (Node, Python, Go process) | AWS Lambda (current), Render, Railway, Fly.io, DigitalOcean App Platform, Heroku |
| **SSR** (Next.js) | Vercel, AWS Amplify (current), Render, Railway |
| **Frontend** (SPA, admin: static) | AWS S3 + CloudFront (current), Vercel, Amplify, Render static |
| **Files** (uploads) | AWS S3 (current); S3-compatible stores (R2, Spaces) through the same adapter |
| **Database** | DynamoDB (current); Postgres through `rt-app-postgres`, provisioned in Neon, Supabase, Railway, PlanetScale Postgres, CockroachDB, Aurora, Cloud SQL |

**How the API adapts.** The request module is already transport-agnostic: `app.handle(request)` does routing, ACL, idempotency and credits. Each runtime only adds a thin entry adapter:
- `rt-app-runtime-http`: a long-running Node server for container PaaS (Render, Railway, Fly.io, DigitalOcean, Heroku);
- `rt-app-runtime-lambda`: the current adapter;
- equivalents for the Python and Go cores.

Business modules never import a provider.

**Database.** A `rt-app-postgres` adapter implements the existing NoSQL store contract (`pk`, `sk`, `version`, `data jsonb`, conditional writes in transactions). Every module, migration and seed runs unchanged. The provider packages only provision the database and hand over the connection URL.

**Admin → Deployments.**
- Per environment: choose one provider per role, enter the API keys, see the plan, apply, and follow status and logs.
- Keeps the same audit trail as today's installer.
- The GitHub workflow calls the selected provider packages on merge.

Suggested order: `runtime-http` + Render or Railway (API), Vercel (SSR/front) and Neon (Postgres). Together they cover a complete non-AWS stack with free tiers and API provisioning. Fly.io, DigitalOcean and Heroku come next, then the rest of the Postgres providers.

## Service Manager

It is built from `~/Projects/rt-app`. It creates projects by running the published initializer (`npm create @gsalgadotoledo/rt-app`) in a terminal it shows, lists templates from the Markdown files, and opens any folder created by the initializer (detected by `rt-app.settings.json`, or `rt-app.md` from 0.2.0).
