# RT-App repository

Read rt-app/AGENTS.md for module conventions. This repository owns the reusable framework; templates/hello-world owns the starter apps. Do not maintain a second editable framework inside templates.

- All npm packages use @gsalgadotoledo/rt-app-* and exact internal release versions.
- npm run prepare:templates builds an application-only snapshot. Generated TypeScript apps consume pinned npm packages; never reintroduce a copied framework tree. Go/Python reference libraries are copied only when that language is selected.
- Run npm ci, npm run build, npm run prepare:templates, npm test, release:pack and release:verify before publication.
- Never commit artifacts, credentials, local databases, Terraform state, installed tools or node_modules. Do not publish automatically on push.
- The owner selected all rights reserved. Keep UNLICENSED metadata and LICENSE files; do not assign an open-source license.
- Go/Python sources are references; npm distribution does not publish them to Go/PyPI registries.
