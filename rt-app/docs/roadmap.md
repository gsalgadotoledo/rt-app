# Roadmap

Each phase ends with a published, verified checkpoint (see organization.md).

## 0.1.0: checkpoint (done, commit 7add289)

Module migrations and seeds (Umzug), credit ledger with weekly allowance, top-ups, rates and sandbox, subscriptions overview, trash confirmation, starter with shared data application, `npm create @gsalgadotoledo/rt-app`.

## 0.2.0: templates as prompts, deploy providers, Service Manager (done)

- **Templates** are `templates/<id>.md`. The front matter declares kind, requirements and CRUD modules; the body is the prompt that tells an LLM what to build on the tested starter. Each project receives its prompt as `TEMPLATE.md`.
- **Deploy roles and providers** (see deploy.md): Render, Railway, Fly.io, DigitalOcean, Heroku, Vercel, Neon and Supabase, plus AWS through Terraform. Also the `rt-app-postgres` store, the portable runtime, the SMTP mailer, `rta deploy`/`rta github`, Admin → Deployments and the GitHub environment workflow.
- **Service Manager:**
  - creates projects by running `npx @gsalgadotoledo/create-rt-app@<its version>` in the wizard terminal;
  - previews template prompts;
  - adds a Deploy panel per project;
  - installs `gh` and `flyctl` with checksum verification.

## Next: slim applications

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

## Next: provider hardening

- Run `rta deploy plan/apply` against real accounts for each provider and close the items listed in deploy.md → Known limits. Also resolve the open questions noted in each provider's README.
- Host the admin in portable deployments (today it is published by the AWS pipeline).
- Files role outside AWS: S3-compatible stores (Cloudflare R2, DigitalOcean Spaces) through the same adapter.
- Public database URLs when the API and the database run on different providers (Railway Public Access).
