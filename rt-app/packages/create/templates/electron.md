---
id: electron
name: Electron desktop
description: React SPA and local API in an isolated Electron window. Packaging stays app-specific.
kind: electron
requirements: [node]
---
# Electron desktop application

The base project plus `apps/desktop` (Electron main process loading the SPA with context isolation, sandbox and no Node integration in the renderer). `npm run dev` starts the API, the SPA and the window.

## What to build

1. Keep all privileged work in the API or in narrowly-scoped preload IPC handlers that validate their input. The renderer never gets Node access.
2. Build the product screens in `apps/spa`.
3. Packaging (code signing, auto-update, installers) is specific to each product: add it in `apps/desktop` with the tool the user chooses (electron-builder or @electron/packager).

## Done when

The window runs the SPA against the local API, IPC handlers are validated and tested, and the user has chosen a packaging approach.
