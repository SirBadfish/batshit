# Batshit Mac

Electron shell, local runtime supervisor, and packaging pipeline for the Batshit Mac app.

This package stays separate from `batshit-app` and `batshit-server`: Electron owns the Mac window and narrow native bridge, while the existing supervisor owns Batshit's local services and user data.

## Current shape

- Shell: Electron 43 with bundled Chromium.
- Default Batshit URL: `http://127.0.0.1:5620/`.
- Bundle ID: `ai.batshit.mac`.
- Standard Electron sandboxed renderers and hidden helper app bundles.
- Context isolation on, Node integration off, web security on, and navigation limited to the packaged startup shell plus explicit Batshit loopback origins.
- One visible app instance; a second launch focuses the existing window.
- One optional Desktop Goon companion window: exact authenticated route, isolated role-scoped preload/state port, transparent frameless policy, no microphone permission, and deterministic return-to-main lifecycle.
- Runtime Doctor starts the packaged SvelteKit app, batshit-server, streamable MCP helper, and Mac-owned Redis before opening the real UI.
- The runtime/data contract remains under `~/Library/Application Support/Batshit`, `~/Library/Logs/Batshit`, and `~/Library/Caches/Batshit` unless an isolated test lane supplies overrides.
- Release runtime target: Apple Silicon on macOS 14 or newer. Node, Redis Stack, OpenSSL, and FFmpeg are package-owned; the build and final package audits reject Homebrew paths, missing loader-relative libraries, unresolved runtime search paths, and native files with a newer deployment target.

The packaged startup UI is served from the privileged `batshit-shell://app` scheme instead of `file://`. The main preload bridge exposes only exact runtime actions, the native save dialog, and the narrow Desktop Goon controller. The Desktop preload exposes only its role-scoped Desktop API; raw Electron and raw `MessagePort` objects never enter app code. Renderer crashes, readiness timeouts, port/schema failures, and unresponsive states remain visible; the shell does not silently reload and discard editor state.

Desktop Goon Mode keeps chat, microphone, speech recognition, audio playback, and session routing in the main renderer. The transparent renderer receives clone-safe snapshots/deltas only after both roles are ready, and the native window is shown only after the Goon renderer reports readiness. Close/failure destroys the Desktop owner before the main Dock is told to remount. `darwin` owns panel/Spaces behavior; deterministic `win32` policy tests are architecture proof only and are not a Windows support claim.

## Commands

Install shell dependencies:

```sh
npm install
```

Build the startup UI and run the Electron shell against the source checkout:

```sh
npm run shell
```

Run with Electron developer tools enabled:

```sh
npm run shell:dev
```

Override the loopback app URL:

```sh
BATSHIT_MAC_DIRECT_URL=http://127.0.0.1:5620/ npm run shell
```

Check the local Electron/package prerequisites and run shell/supervisor tests:

```sh
npm run doctor
npm test
```

Create the local signed macOS package, audit it, and create the local ZIP:

```sh
npm run prepare:managed-runtimes
source ../_local/mac-managed-runtimes/assets/managed-runtime-assets.env
npm run package:mac
npm run package:audit
npm run package:zip
```

The preparation command prints the exact generated environment-file path when a custom asset root is configured; source that reported file before packaging.

The normal app bundle is `zig-out/package/Batshit.app`, matching the product name shown in Finder and the Dock. Version and release-safety labeling remain on distributable artifacts such as `Batshit-0.1.0-macos-ReleaseSafe.zip` and `.dmg`, while isolated review builds use an explicit app suffix such as `Batshit-SA090-R7.app`. Direct `npm run package:mac` builds remain ad-hoc unless `MACOS_CODESIGN_IDENTITY` or `BATSHIT_MAC_SIGN_IDENTITY` is set. Team development rebuild tooling can automatically reuse an installed Developer ID so repeated local rebuilds retain one macOS code identity; `BATSHIT_MAC_SIGNING_MODE=stable` requires that identity and `BATSHIT_MAC_SIGNING_MODE=ad-hoc` explicitly opts out.

Maintainers can launch the disposable first-run test lane from the private checkout. It rebuilds the same Electron package, wipes only the disposable first-run data/log/cache roots, and runs on isolated local ports without touching the normal Mac app data.

## Public DMG

Josh accepted the long-session Electron package behavior. Managed-runtime preparation now builds a checksum-verified OpenSSL 3.5 LTS pair for Redis, builds FFmpeg with dependency autodetection and X11/XCB disabled, and independently audits the prepared assets plus their final copies inside the app.

After the ReleaseSafe package audit passes:

```sh
npm run package:dmg:check
BATSHIT_MAC_NOTARY_PROFILE=batshit-notary npm run package:dmg
```

The DMG path stages a copy of `Batshit.app`, signs the complete Electron dependency graph with a Developer ID Application certificate, creates and signs the DMG, submits it to Apple notarization, staples the ticket, and runs Gatekeeper verification. It auto-detects the first valid `Developer ID Application:` identity or uses `BATSHIT_MAC_SIGN_IDENTITY` / `--identity`.

Release signing requires Apple Developer Program membership, a valid Developer ID Application certificate in the keychain, and a stored `notarytool` profile. Never place Apple passwords, private keys, or API keys in the repository or chat logs.

## Packaging boundaries

The package build uses an immutable `app.asar`, Electron fuse hardening, a custom packaged-shell protocol, microphone/speech privacy descriptions, Batshit's managed Node/Redis/OpenSSL/FFmpeg runtimes, trusted Goon assets, and the runtime package audit. It fails if Electron's framework/helpers, the runtime payload, portability contract, privacy metadata, or trusted asset inventories are incomplete.

Electron replaces only the desktop shell. Docker, source-checkout Native BS, the SvelteKit application, batshit-server, backup/restore, and Mac runtime data formats do not change.
