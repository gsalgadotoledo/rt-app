# RT-App

Backend modules, admin, CLI and app templates. npm scope: `@gsalgadotoledo`. Alpha: `0.1.0`. All rights reserved.

```sh
npm ci
npm run release:check
# Authenticated owner only, after verification:
npm run release:publish
```

```text
rt-app/                 Reusable core: modules, admin, CLI, language libraries, infrastructure and tools
templates/hello-world/  Application code and application infrastructure
.github/workflows/      Validation and manual npm publication
```

New projects install the core from npm; they do not copy its TypeScript sources. See [RELEASING.md](RELEASING.md) for publication and platform requirements.
