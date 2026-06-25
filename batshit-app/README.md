# Batshit App

SvelteKit app for Batshit: chat UI, settings, API routes, Redis-backed data access, direct `API` agents, managed `CLI` agent bridges, artifacts, voice, Goons, and the browser-facing proxies into batshit-server.

This is not the public install path. Normal users should use the packaged Mac app or Docker from the root docs. This folder README is for maintainers and contributors working on the app source.

Run app package commands from this folder, not the repo root.

```sh
npm ci
npm run check
npm run test
npm run build
```

Useful notes:

- TypeScript/Svelte changes should finish with `npm run check`.
- Default tests use the app's mocked Redis/AI SDK harness; real Redis suites use `npm run test:redis`.
- The Docker app image builds with dev dependencies present, bundles client code, then prunes dev dependencies for runtime.
