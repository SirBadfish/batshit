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
- Release runtime target: Apple Silicon on macOS 14 or newer. Node, Redis 8, OpenSSL, and FFmpeg are package-owned; the build and final package audits reject Homebrew paths, missing loader-relative libraries, unresolved runtime search paths, and native files with a newer deployment target.

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

## Developer tools

Chromium developer tools are disabled in every window by default, including the signed package. A
renderer console is a real attack surface: anyone who can talk a user into pasting script into it
runs that script inside the authenticated app session. The shell therefore requires a deliberate
local opt-in instead of shipping the tools enabled.

`resolveDevToolsEnabled` in `src-electron/electron-shell-policy.mjs` decides this once at startup and
applies the same answer to the main window, the Desktop Goon window, and the Desktop Controls window:

1. `BATSHIT_MAC_ENABLE_DEVTOOLS=1` forces the tools on, and `=0` forces them off. `npm run shell:dev`
   uses the first form.
2. Otherwise the shell enables the tools when an opt-in marker file exists at
   `<Mac data root>/enable-devtools`, which is `~/Library/Application Support/Batshit/enable-devtools`
   unless `BATSHIT_MAC_DATA_DIR` overrides the root.
3. Otherwise the tools stay off.

The marker is an empty file and its contents are never read:

```sh
touch ~/Library/Application\ Support/Batshit/enable-devtools
```

The marker lives in the Mac data root rather than the app bundle, so it survives repackaging and
keeps working for a Dock-launched signed app. It is deliberately outside the backup allowlist
(`redis/records/*` and `files/uploads/*`), so a backup never carries one machine's developer opt-in
into a restore on another machine. Delete the file to turn the tools back off.

With the tools enabled, open them with `Option + Command + I`, the default `View` menu, or the
developer context menu described below. `F12` is not bound on macOS.

### Developer context menu

Electron ships no context menu of its own. When developer tools are enabled, the main window gains a
right-click menu with `Inspect Element` (which opens the tools on the exact element under the
pointer), `Reload`, and `Reapply Custom CSS` when a custom stylesheet exists. The handler is attached
only when the opt-in above resolved true, so an ordinary install keeps Electron's no-menu default.

## Main window size and position

The main window remembers its size, position, and maximized state between launches in
`<userData>/main-window-state-v1.json`, written atomically and private to the user. Saving is
debounced on resize, move, maximize, and unmaximize, and runs once more on close. Minimized and
full-screen states are not saved, and `getNormalBounds` is used so a maximized window still records
the size it will restore to.

`restoreMainWindowBounds` in `src-electron/main-window-policy.mjs` decides what is safe to restore.
Saved bounds are never trusted, because displays are disconnected, resized, and rearranged between
runs. The window is clamped to the `minWidth`/`minHeight` policy so both persistent rails plus the
480px chat column always survive, shrunk to fit a smaller work area, and pulled back until a
reachable strip of its title bar is on screen. Without that last step a window saved on a
second display would open off-screen and could not be moved back without deleting the state file.

Window geometry is cosmetic, so an unusable or corrupt state file is reported to the log and then
replaced by the default policy rather than blocking startup. This is the one place in the shell
where falling back is correct: refusing to open the window would be the worse failure.

## Custom stylesheet

The main window applies an optional local stylesheet from `<Mac data root>/custom.css`, which is
`~/Library/Application Support/Batshit/custom.css` unless `BATSHIT_MAC_DATA_DIR` moves the root or
`BATSHIT_MAC_CUSTOM_CSS` names an exact file. A missing file is the normal state and applies nothing;
an unreadable, oversized, or non-regular file is logged rather than silently skipped.

`CustomStyleOverrides` in `src-electron/local-style-overrides.mjs` owns this. It re-reads the file on
every document load and polls it for changes, so saving the file restyles the running app without a
reload or restart. Electron discards inserted CSS across navigations, so the stale key is abandoned
on load instead of being removed from the new document.

The stylesheet is inserted with Electron's default author origin, appended after the app's own
stylesheets. Ordinary cascade rules therefore apply, and anything written there ports into
`batshit-app/src/app.css` unchanged. A user-origin sheet would instead need `!important` on every
rule, which would make the experiment harder to promote into real product CSS.

This file is deliberately outside the repository and outside the backup allowlist, so it is never
committed and never travels to another machine in a restore.

### Web font imports

Chromium ignores `@import` inside a stylesheet inserted through `insertCSS`. A Google Fonts
one-liner would therefore apply its `font-family` and silently fall back to a system face, which
looks like a working font change until the letterforms are examined closely.

`inlineStyleImports` resolves this before injection: each `@import` is fetched in the main process
and spliced in, leaving plain `@font-face` rules that the renderer fetches as it would on any page.
Imports must be `https` and must target `fonts.googleapis.com` or `fonts.bunny.net`, which bounds
what a local file can make the main process request. At most 10 imports are fetched, each capped at
512 KB with a 10 second timeout, and results are cached per URL so repeated saves do not refetch.

A failed or disallowed import is logged and leaves a comment in place of the rule, so a font that
does not arrive is visible rather than silent. The rest of the stylesheet is still applied.

The request sends a current Chrome user agent because Google Fonts serves a different stylesheet per
agent, and Electron's own agent would be given older formats instead of woff2.

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

The normal app bundle is `electron-out/package/Batshit.app`, matching the product name shown in Finder and the Dock. Version and release-safety labeling remain on distributable artifacts such as `Batshit-0.1.0-macos-ReleaseSafe.zip` and `.dmg`, while isolated review builds use an explicit app suffix such as `Batshit-SA090-R7.app`. Direct `npm run package:mac` builds remain ad-hoc unless `MACOS_CODESIGN_IDENTITY` or `BATSHIT_MAC_SIGN_IDENTITY` is set. Team development rebuild tooling can automatically reuse an installed Developer ID so repeated local rebuilds retain one macOS code identity; `BATSHIT_MAC_SIGNING_MODE=stable` requires that identity and `BATSHIT_MAC_SIGNING_MODE=ad-hoc` explicitly opts out.

Maintainers can launch the disposable first-run test lane from the private checkout. It rebuilds the same Electron package, wipes only the disposable first-run data/log/cache roots, and runs on isolated local ports without touching the normal Mac app data.

## Public DMG

Josh accepted the long-session Electron package behavior. Managed-runtime preparation builds a checksum-verified OpenSSL 3.5 LTS pair for Redis and FFmpeg with dependency autodetection and X11/XCB disabled. FFmpeg includes a statically linked, checksum-pinned dav1d 1.5.4 AV1 decoder built for Apple Silicon. FFprobe and FFmpeg are package-owned; dav1d shares the macOS 14 minimum and its BSD-2-Clause notice/source/checksum records ship with the runtime. The prepared assets and their final copies inside the app are audited independently.

Meson, Ninja and pkg-config must be available on PATH when rebuilding dav1d; they are build-only prerequisites and stay outside the packaged runtime. This software decoder serves `batshit-server`, not Electron's video element.

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
