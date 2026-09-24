
## Local tools and discovery

Global services → Add tools installs PostgreSQL, MongoDB, Redis or a JSON HTTP server into the manager's private directory. Installed versions are pinned; removing an entry preserves its database and binaries. PostgreSQL uses loopback-only trust authentication for local development. Redis requires Apple's Command Line Tools to compile its verified source release. Portable installers currently target macOS. SQLite creates an embedded database file: it has no background server to start or stop.

Discover services proposes npm/Electron, Go and Python entry points without executing them. Add a proposal to register it, then start it explicitly. Vite/Next and the local TypeScript backend support automatic reload; Go/Python use the command configured by the project (Django's runserver already reloads). Detection does not infer dependencies or install language toolchains.

## Application commands

Select a project → **Commands** → choose an application script → **Run**. The selector defaults to `dev`. Existing managed dev commands reuse their service; other scripts get an independent task and output page. Start project does not run these extra tasks. Stop project also stops them. Closing the window keeps processes running; changing configuration or restarting the supervisor clears transient command history.

All `package.json` scripts are read on demand, including tests/builds. Refresh after editing manifests. Scripts run only after clicking Run; npm lifecycle hooks apply as usual. Source-installed admin exposes its scripts; the published admin exposes its managed dev service because its development tests/toolchain are not distributed. Concurrent commands can still write the same build directory: avoid running a production build against a dev server that shares its output directory.

Python, Go or other apps can declare `rt-app.commands.json` next to their source:

```json
{
  "version": 1,
  "name": "Go API",
  "commands": {
    "dev": {"command": ["go", "run", "."], "description": "Start API (no watcher)"},
    "test": {"command": ["go", "test", "./..."], "description": "Run tests"}
  }
}
```

Commands use argument arrays, not shell evaluation. Existing Python/Go commands keep their configured behavior. New native backend templates use a source watcher for `dev`, a plain launch for `start`, and tests for Python/Go. Vite/Next provide browser refresh; native source changes restart the backend. This is development reload, not automatic browser refresh for arbitrary applications.

```sh
rta services commands --json
rta services run-command COMMAND_ID --json
```
