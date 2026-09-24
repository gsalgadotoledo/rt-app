# Local service manager

The reusable module lives in `rt-app/packages/service-manager`:

- `native/`: Rust supervisor and JSON CLI (`rt-app-services`).
- `client.mjs`: local IPC client shared by agents and the desktop host.
- `ui/ServiceManager.tsx`: one exported React component, independent of Electron.
- `electron/`: isolated Electron window and a narrow preload bridge.

## Start from the project

```sh
npm ci
npm run desktop
```

The first source checkout launch requires **Rust/Cargo** to build the supervisor.
Node/npm are still needed by this starter's JavaScript services. The desktop opens
without starting them; select **Start all**, or start individual services. Preparation
runs before dependent applications; unrelated processes start concurrently.

`npm run dev` and `npm start` use the same native supervisors. Ctrl+C stops the project
services; shared services remain available to other projects. A desktop window and multiple CLI clients share one daemon per project,
so they do not start duplicate services. Closing the desktop window **keeps services
running**. Use **Stop all** or the shutdown command to stop them.

The table shows managed status, process-tree CPU and memory, URLs, and controls.
The percentage is the number of ready enabled services, **not an estimated build
progress**. CPU may exceed 100% on multiple cores. The detail pane retains the latest
600 bounded output entries per service, with stdout/stderr labels. Logs are in memory
and reset when the daemon stops. Inherited secret values are redacted on a best-effort
basis; do not deliberately print credentials or put them in command arguments.

Previously configured ports occupied by unmanaged processes are shown as blocked. The manager
never adopts or kills those processes. Stop their original `npm run dev` before using
this manager. Explicit dependency stops cascade to dependent services. Restart waits
for the previous process group to exit before launching another one.

## CLI for developers and agents

```sh
npm run services -- daemon
npm run services -- status --json
npm run services -- start api --json
npm run services -- restart ssr --json
npm run services -- logs api --json
npm run services -- stop all --json
npm run services -- shutdown
```

For pure machine-readable output, call `rta services ... --json` directly or use
`npm run --silent services -- ... --json`. A first native compilation can also print
Cargo progress to stderr. `rta tools --json` exposes the commands to agents.

The standalone Rust executable also supports the same operations:

```sh
rt-app-services serve --project /path/to/project --config /path/to/services.json
rt-app-services status --project /path/to/project --json
rt-app-services start api --project /path/to/project --json
```

The framework generates `.rt-app/services.json` from `rt-app.settings.json`. This
resolved manifest uses argument arrays and has no language-specific runtime engine.
The daemon exposes an authenticated loopback-only JSON protocol, with an owner-only
random token stored under `.rt-app`. Renderer JavaScript cannot read that token,
execute arbitrary commands, navigate to remote pages, or access Node directly.

## Other languages and infrastructure

Add entries to `services.extra` in `rt-app.settings.json` for project services, or `extra` in
`~/.rt-app/service-manager/settings.json` for global services; set `enabled: false` to keep
an optional service out of **Start all**. Direct starts can still start it. For example:

```json
{
  "id": "postgres",
  "label": "PostgreSQL",
  "enabled": false,
  "cwd": ".",
  "command": ["postgres", "-D", ".rt-app/postgres"],
  "ports": [5432],
  "portEnv": ["PGPORT"],
  "stopTimeoutMs": 30000,
  "dependencies": []
}
```

Install PostgreSQL and initialize that directory with `initdb` first. The manager does
not silently install database servers or initialize/erase database data. The default
starter uses JSON files **inside the API**, so it has no separate JSON database process.
Mailpit is already included and retains its existing verified first-run installation.

Python (`uv run ...`), Go (`go run ...`), Java (`java -jar ...`), and other tools work the
same way when installed. Commands run without a shell, in a directory inside the
selected project. Use `inheritEnv` to explicitly pass required environment variables;
use `env` for non-secret configuration. `readyUrl` may specify a loopback HTTP health
endpoint. Without one, running means the process is alive, not that a database has
finished initializing. `kind: "task"` denotes a prerequisite that completes with exit 0.

Inherited passwords and PATH are captured when the daemon starts. After changing
these, shut down that project daemon and start it again. The port editor reloads
configuration without losing its inherited environment. Manual configuration edits
are reconciled when opening the project again. **Restart build** rebuilds TypeScript and restarts its active dependents.

## Embed in another React/Electron app

```tsx
import {ServiceManager} from '@gsalgadotoledo/rt-app-service-manager/ui';

<ServiceManager client={myPreloadBridge} />
```

The bridge implements `snapshot()`, `action(action, id)`, `logs(id)`, and optional
`openUrl(id)`. See `ManagerClient` in the component. Only the main process connects to
the daemon. Styling is scoped to `.rt-services`; the standalone shell owns page styles.
You can reuse the native binary independently of Electron.

## Desktop application

```sh
npm run desktop:package
```

The generated host-platform application is in the module's `release/` directory.
The macOS Apple Silicon build is tested locally. It includes the Rust binary and does
not require Cargo; it still needs the tools used by your services. Electron includes
Chromium, so the application bundle is larger than the native supervisor alone.
Distribution signing/notarization and Linux/Windows desktop validation are not included
in this first version. Do not bypass system security warnings to run a downloaded build.

On first opening the packaged application, select the project folder. A Finder launch
does not inherit credentials from a terminal. Start the daemon once from the terminal
with `npm run services -- daemon`, then open the application to
control that same daemon. Changed credentials require restarting the daemon.

## Local versus AWS backend

The same `rt-app.settings.json` defines `runtime.local` and `runtime.aws` profiles.
The core selects AWS when Lambda supplies `AWS_LAMBDA_FUNCTION_NAME` or
`AWS_LAMBDA_RUNTIME_API`. `RT_APP_TARGET=aws` explicitly selects cloud adapters outside
Lambda. Having AWS access keys in a local shell does **not** select AWS automatically.
Local settings cannot be selected inside Lambda; invalid combinations fail closed.

The local server selects JSON/memory/local DynamoDB as configured. The Lambda entrypoint
loads the existing DynamoDB/Cognito/SES production implementation. It never launches
the desktop supervisor. This selects existing adapters; it does not translate modules
between languages or provision cloud resources during local startup.

## Global services and projects

The navigation separates **Global services** from **Project services**. Start/Stop/Restart
all applies to the selected category. Mailpit is global: it has one process, one inbox,
and one data directory per OS user. Stopping a project never stops shared email. Global
stops deliberately affect all consumers. JSON storage remains private to each project.

Use **Open project…** to select a folder containing `rt-app.settings.json` (version 1)
and `package.json`. Opened projects are remembered in
`~/.rt-app/service-manager/projects.json`. Switching projects leaves other projects
running; each row identifies its owner. The file is the project marker; no custom
extension or OS hosts entry is required. Only open trusted projects: their configured
commands execute with your user privileges when started.

On first registration, defaults are API 4010, admin 5174, SPA 5175 and SSR 5176. The
manager advances an unconfigured port if it is busy or reserved by a registered project.
Explicitly configured ports are preserved. Local settings are saved in the project:

```json
"local": {"ports": {"api": 4010, "admin": 5174, "spa": 5175, "ssr": 5176}}
```

**Configure ports** edits these application ports, or Mailpit SMTP/UI ports in the global
view. **Save & restart active services** validates the values, stops active services,
reloads the manifest and resumes the previously active services. Inactive services stay
inactive. Changing global mail ports refreshes the registered running projects too.
All applications receive the same `RT_APP_*_URL` values; Vite, Next.js, backend origin
checks and SMTP connections consume those values. No source file rewriting is required.
A successful save is configuration acceptance, not a promise that every application
will start successfully; individual errors remain in the status and console.

URLs use `http://localhost:<port>` and open in the browser when clicked. Services still
bind to loopback. There are no hosts-file changes, local DNS installations, domains,
certificates or administrator permissions involved. The editor covers the starter's four application ports, Mailpit's two ports and
custom services that declare `portEnv` (one environment name per editable port).
For example PostgreSQL declares `ports: [5432]` and `portEnv: ["PGPORT"]`; the manager
injects the selected value as `PGPORT`. Custom commands must read those variables,
rather than hardcode a port in their arguments. Custom global services such
as PostgreSQL use their declared command, ports and environment in global `extra`;
install/init the database first and reopen a project after editing that configuration.
Their data directory should live under the global directory, not a particular project.

```sh
npm run services -- start global:mail
npm run services -- stop global:all
npm run services -- restart all
npm run services -- ports project 4010 5174 5175 5176
npm run services -- ports global 1025 8025
npm run services -- shutdown         # project daemon only
npm run services -- shutdown global  # shared daemon and services
```

The global Mailpit command references the framework CLI in the first opened checkout.
Keep that checkout installed, or update `mailCommand` in the global settings when moving
it. Mailpit's cache and inbox themselves live under the global directory. Existing
project-local inboxes are preserved and are not automatically merged into the shared one.

## Menu bar and login startup (macOS)

The desktop stays in the menu bar when its window closes. Its menu offers all-project
Start/Stop/Restart, global services, per-project and per-service controls, and Open
dashboard. **Stop everything and quit** stops managed services; **Quit manager (keep
services running)** only exits Electron. Unmanaged processes are never stopped.

The packaged macOS app registers a per-user LaunchAgent on first launch at
`~/Library/LaunchAgents/dev.rtapp.services.plist`. At the next login it starts hidden
and launches enabled services in every registered project. This runs after user login,
not before login as a root/system daemon. Disabled optional services remain disabled;
errors stay visible in the menu and service console. Startup can be disabled using
**Start at login · all registered projects**. A manual quit does not disable next-login
startup. No automatic restart loop is used after a process crashes.

Keep the packaged application and registered project folders at their installed paths.
The agent stores the executable path and PATH only, never AWS keys or ADMIN_PASSWORD.
Local admin does not require a password. Cloud installation and remote administration
require ADMIN_PASSWORD; shell-only environment secrets do not survive logout/reboot.
The manager does not silently save passwords in files or in the login agent.

Source `npm run desktop` has the tray too, but login registration uses the packaged
macOS application. Windows/Linux login integration is not implemented in this version.
