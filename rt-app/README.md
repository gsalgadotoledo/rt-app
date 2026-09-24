# RT-App core

- `src/`: backend composition (`@gsalgadotoledo/rt-app-framework`).
- `core-ts/`, `core-go/`, `core-python/`: language-specific component registries.
- `packages/`: adapters, domain modules, observer, service manager and project generator.
- `admin/`: shared admin UI and its backend.
- `cli/`, `installer/`: commands and AWS installation.
- `packages/infra/terraform/`: reusable infrastructure, including admin hosting.
- `scripts/`: shared development and release tools.

Apps import npm packages. `main.js` configures composition; `modules.json` enables features.
Run `rta admin` in an application to serve the shared admin. `rta build` builds the app workspaces and writes its admin assets to `.rt-app/admin/`; it never writes a project build into the installed package.

Read [AGENTS.md](AGENTS.md) for module conventions.
