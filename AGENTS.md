# RT-App repository

Read rt-app/AGENTS.md for module conventions. This repository owns the reusable framework; templates/hello-world owns the starter apps. Do not maintain a second editable framework inside templates.

- All npm packages use @gsalgadotoledo/rt-app-* and exact internal release versions.
- npm run prepare:templates builds a sanitized source snapshot for the generator. The initial generator intentionally includes editable framework workspaces; migration to registry-only starter dependencies is separate work.
- Run npm ci, npm run build, npm run prepare:templates, npm test, release:pack and release:verify before publication.
- Never commit artifacts, credentials, local databases, Terraform state, installed tools or node_modules. Do not publish automatically on push.
- License is UNLICENSED until the owner selects redistribution terms. Do not assign an open-source license without authorization.
- Go/Python sources are references; npm distribution does not publish them to Go/PyPI registries.
