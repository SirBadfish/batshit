# LiveKit Agent Sidecar

This package is the optional native LiveKit agent sidecar used by Batshit's realtime voice path. It is installed and launched by Batshit's Voice settings/runtime manager when LiveKit voice support is configured.

Commands:

```sh
npm install
npm run check
npm run start
```

Notes:

- `tsx` is a runtime dependency because the start script runs the TypeScript entrypoint directly.
- The sidecar is not part of the core Batshit app container.
- Local install roots and runtime state belong under Batshit's managed runtime folders, not in this source package.
