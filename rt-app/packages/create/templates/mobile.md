---
id: mobile
name: Mobile · Expo
description: React Native (Expo) screen talking to the same API, with an editable API URL.
kind: mobile
requirements: [node]
---
# Mobile application (Expo)

The base project plus `apps/mobile` (Expo). It runs in Expo Go. A physical phone needs your computer's reachable address as the API URL.

## What to build

1. Authentication against the API (`/auth/login`), storing the token with `expo-secure-store`, never in plain storage.
2. The product screens, sharing API contracts with the SPA.
3. Native builds (EAS) and store publishing are separate steps; ask the user before configuring them.

## Done when

The app signs in and uses the API from a real device, and tokens are stored securely.
