# Releases

All packages use `@gsalgadotoledo/rt-app-*`, version `0.1.0-alpha.0`, npm tag `next`. Repository is private; npm packages will be public only when explicitly published. License remains UNLICENSED pending an owner decision.

## Validate locally
```bash
npm ci
npm run build
npm run prepare:templates
npm test
npm run release:pack
npm run release:verify
```

Inspect `artifacts/manifest.json`. Packing validates internal versions, exports and file exclusions. Verification installs the exact tarballs in an empty directory and exercises core/framework imports, CLI, generation and the generated application build. Keep release artifacts out of git.

## First publication
The owner signs into npm interactively; never put tokens or passwords in source or chat.
```bash
npm login
npm whoami
npm run release:publish
```
The publish command sends verified tarballs in dependency order with public access and the `next` tag. npm may ask for 2FA. A partially published release is not rolled back automatically. Inspect npm before retrying; immutable versions cannot be replaced.

## Future GitHub OIDC publication
After the packages exist, configure each package's Trusted Publisher:
- Organization/user: gsalgadotoledo
- Repository: rt-app
- Workflow: publish.yml
- Environment: npm
- Allow the publish action.

Configure protection/required reviewers on the GitHub `npm` environment. The workflow is manual, has `id-token: write`, and does not use NPM_TOKEN. No provenance is requested while the repository is private. OIDC publishing requires npm >=11.5.1 and Node >=22.14.

## Current boundaries
The generator's sanitized starter still carries editable framework sources and local workspaces. CLI deployment/desktop commands target this generated layout. Registry-only starter dependencies and a prebuilt cross-platform native supervisor are not claimed by this release. Desktop packaging needs platform build tools; Go/Python distribution is separate.
