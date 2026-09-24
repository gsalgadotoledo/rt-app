# Releases

All npm packages use `@gsalgadotoledo/rt-app-*`, version `0.1.0-alpha.0`, tag `next`. The GitHub repository is private; npm packages are public when published. Public visibility grants no license: all rights remain reserved.

## Validate and publish
```sh
npm ci
npm run release:check
npm login
npm whoami
npm run release:publish
```

Validation builds and tests the framework, prepares the app-only template, checks packed exports and exclusions, then installs the tarballs in an empty directory. It generates and builds an application without a source copy of the core and bundles its Lambda, starts the installed admin, runs generated app tests and validates Terraform without applying resources. Terraform 1.11+ is required for release validation; TF_CLI_PATH can select a separate executable. Artifacts are hash-verified before publication, in dependency order. Interrupted publication can resume: already published versions are skipped only when their integrity matches exactly. A conflicting immutable version fails rather than being overwritten. Never commit tokens, state, databases or release artifacts.

## GitHub OIDC
After the first publication, configure each package's Trusted Publisher for user `gsalgadotoledo`, repository `rt-app`, workflow `publish.yml`, environment `npm`. Protect that GitHub environment with required reviewers. The workflow is manual and uses OIDC; no npm token is stored. GitHub Actions must be enabled and the account billing limit must allow a runner. Private-repository provenance is not requested.

## Supported scope
- Node/TypeScript: local development and AWS deployment tooling. No AWS resources are created by release checks.
- Generated projects install version-pinned npm dependencies; application source stays editable.
- Desktop/CLI service supervision currently needs Rust/Cargo to build the local supervisor. The desktop packaging command bundles that native binary for its build platform. Portable database installers and automatic login currently target macOS.
- Go/Python/Java templates support local development with the Node backend providing admin/auth/CRUD. Their AWS deployment and Go/PyPI distribution are separate future features; unsupported deployment commands fail explicitly.
- Hosted Stripe/AWS integrations require the application's own credentials and configuration. Release checks use local adapters and test doubles.
