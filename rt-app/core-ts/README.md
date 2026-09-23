# RT-App TypeScript core

The existing `@gsalgadotoledo/rt-app-core` package now lives in `rt-app/core-ts` (previously `rt-app/packages/rt-app`). Its public imports and runtime API are unchanged. It contains the module manager, base module and TypeScript contracts. The admin and feature modules remain separate packages under `rt-app`.

From the project root:

```sh
npm run test -w @gsalgadotoledo/rt-app-core
npm run core:pack
```

The tarball is generated under `.rt-app/npm`. This is a library consumed via npm dependencies. `create-rt-app` is the separate CLI used through a local link or npx; npx does not encapsulate the language cores into one runtime.

Go and Python siblings implement their own idiomatic provider APIs, not a line-for-line port of this module manager. See `../core-go/README.md` and `../core-python/README.md`.
