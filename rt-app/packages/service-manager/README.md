
## Local tools and discovery

Global services → Add tools installs PostgreSQL, MongoDB, Redis or a JSON HTTP server into the manager's private directory. Installed versions are pinned; removing an entry preserves its database and binaries. PostgreSQL uses loopback-only trust authentication for local development. Redis requires Apple's Command Line Tools to compile its verified source release. Portable installers currently target macOS. SQLite creates an embedded database file: it has no background server to start or stop.

Discover services proposes npm/Electron, Go and Python entry points without executing them. Add a proposal to register it, then start it explicitly. Vite/Next and the local TypeScript backend support automatic reload; Go/Python use the command configured by the project (Django's runserver already reloads). Detection does not infer dependencies or install language toolchains.
