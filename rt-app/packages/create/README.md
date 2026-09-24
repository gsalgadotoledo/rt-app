# @gsalgadotoledo/rt-app-create

New projects: `npm create @gsalgadotoledo/rt-app my-app` (package `@gsalgadotoledo/create-rt-app`). This package is the generator library and templates used by that command, the Service Manager and `rt-app-create` (bin) for scripted use.


The desktop wizard and CLI share this generator and `templates/catalog.json`.

## Develop locally without publishing

From the starter root:

```sh
npm link --workspace @gsalgadotoledo/rt-app-create --ignore-scripts
```

From any directory:

```sh
rt-app-create --workspace "$HOME/Projects" --name my-app --template fullstack
rt-app-create --list
```

The global command is a symlink to the development source. If you switch Node installations with nvm, run the link command again for that Node installation. Remove only the link with `npm unlink --global @gsalgadotoledo/rt-app-create`.

Without a global link, run `node /absolute/path/to/rt-app/packages/create/bin/create.mjs --help`.

## Test an npm release locally

```sh
npm run generator:pack
npx --yes --package ./.rt-app/npm/rt-app-create-0.1.0.tgz rt-app-create --list
```

The tarball contains the sanitized starter and works without the original repository. No npm publication is performed. After publishing under a scope you own, the equivalent command is `npx @gsalgadotoledo/rt-app-create --workspace ... --name ...`. The core runtime has its own `npm run core:pack` command and `@gsalgadotoledo/rt-app-core` package.

## Templates and tools

Built-in templates use a versioned local snapshot, so no Git installation or remote repository is required. The core catalog defines each template's requirements and customization. Full stack copies the starter; shopping cart and CRM add editable CRUD modules; Electron adds a sandboxed window; mobile adds an Expo screen. These are development starters, not completed commerce/CRM products.

An optional catalog `source` may use a Giget GitHub/GitLab reference pinned to a full commit SHA. Remote catalogs cannot be supplied through the desktop UI. Templates are trusted executable source; additions are reviewed as core code.

The wizard installs missing Node/Go/Python through a checksum-pinned mise binary, under the user's RT-App directory. It does not edit shell profiles, use sudo, or overwrite a system toolchain. macOS and Linux arm64/x64 are supported; Windows automatic installation is not yet supported. Python/Go are optional until required by a template. Android/iOS SDKs and signing are not installed automatically. A physical phone needs a reachable API address; localhost works on the host, not on another device.

Names are validated and existing project folders are never overwritten. Source generation failures roll back the newly reserved folder. If npm installation fails, the code remains in place for inspection and `npm install` retry. Credentials, databases, Terraform state, build output and repository history are never part of the starter snapshot.
