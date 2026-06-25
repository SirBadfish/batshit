# Batshit App

SvelteKit app for Batshit: chat UI, settings, API routes, Redis-backed data access, direct `API` agents, managed `CLI` agent bridges, artifacts, voice, Goons, and the browser-facing proxies into batshit-server.

Run package commands from this folder, not the repo root.

```sh
npm install
npm run check
npm run test
npm run build
```

Useful notes:

- Public install paths are the packaged Mac app and Docker. Source-checkout development is a maintainer workflow, not the normal user setup path.
- TypeScript/Svelte changes should finish with `npm run check`.
- Default tests use the app's mocked Redis/AI SDK harness; real Redis suites use `npm run test:redis`.
- The Docker app image builds with dev dependencies present, bundles client code, then prunes dev dependencies for runtime.
