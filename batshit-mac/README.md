# Batshit Mac

Zero Native shell for the Batshit Mac app story.

This package is intentionally separate from `batshit-app` and `batshit-server` so the Mac shell can move quickly without disturbing the existing web app or Docker path.

## Current Shape

- App shell: Zero Native 0.2.0
- Default web engine: system WKWebView
- Experimental web engine: bundled Chromium/CEF investigation lane, not launch-supported yet
- Zig runtime: local Zig 0.16.0 download managed by `scripts/ensure-zig.mjs`
- Default Batshit URL: `http://127.0.0.1:5620/`
- Bundle id: `ai.batshit.mac`
- Window: `1280x820`

The packaged shell owns the local Batshit app/server/Redis supervisor path and opens the real Batshit UI after runtime health checks pass. Runtime Doctor remains the repair surface when prerequisites or managed services need attention.

## Commands

Install shell dependencies:

```sh
npm install
```

Run against an already-started Batshit instance:

```sh
npm run shell
```

Run the no-browser Batshit stack and then open the shell:

```sh
npm run shell:dev
```

Override the app URL:

```sh
BATSHIT_MAC_DIRECT_URL=http://127.0.0.1:5620/ npm run shell
```

Maintainers can launch a disposable first-run test lane for packaged-app QA from
the private development checkout. That lane rebuilds the WKWebView package,
wipes only disposable first-run test data, and opens the packaged app on
isolated local ports so normal Mac app data and login state stay separate.

Validate the Zero Native manifest:

```sh
npm run doctor
```

Run Zig tests:

```sh
npm run test
```

Create a local macOS package:

```sh
npm run package:mac
```

Run the package audit and ZIP step when preparing a release candidate:

```sh
npm run package:audit
npm run package:zip
```

Create the public Mac release DMG after the ReleaseSafe app passes package audit:

```sh
npm run package:dmg:check
BATSHIT_MAC_NOTARY_PROFILE=batshit-notary npm run package:dmg
```

The DMG command signs a staged copy of `Batshit.app` with a Developer ID Application certificate, creates `zig-out/package/Batshit-0.1.0-macos-ReleaseSafe.dmg`, signs the DMG, submits it to Apple notarization with `xcrun notarytool`, staples the notary ticket, and runs Gatekeeper verification. It auto-detects the first valid `Developer ID Application:` identity, or uses `BATSHIT_MAC_SIGN_IDENTITY` / `--identity`.

This command requires release-owner Apple credentials on the Mac before it can pass:

- Apple Developer Program membership.
- A valid `Developer ID Application` certificate in the keychain.
- A stored notary profile, for example:

```sh
xcrun notarytool store-credentials "batshit-notary" --apple-id <email> --team-id <team-id> --password <app-specific-password>
```

Do not paste Apple passwords, app-specific passwords, private keys, or API keys into chat logs. Store them in the macOS keychain or Apple-recommended credential files.

Create an experimental bundled-Chromium package for local investigation only:

```sh
npm run package:mac:chromium
npm run package:audit:chromium
```

The Chromium package downloads Zero Native's pinned CEF runtime into `third_party/cef/macos` when missing and writes a separate `zig-out/package/Batshit-0.1.0-macos-ReleaseSafe-Chromium.app` artifact. It uses `app.chromium.zon` plus the `ai.batshit.mac.chromium` bundle id so macOS treats it as a separate test app from the normal WKWebView artifact. This lane is currently blocked for user-facing launch: 2026-05-30 double-click testing opened a blank window and showed CEF helper subprocesses as extra visible Dock icons because the package has no hidden macOS CEF helper app bundles. The normal `package:mac` path stays WKWebView unless a future Chromium helper-packaging fix passes live double-click proof.

The package build cleans the target app bundle under `zig-out/package/` before each run. This prevents stale executables or resources from a prior WKWebView/Chromium build from surviving inside the next package.

## Notes

The generated frontend remains for package experiments, but the current shell loads Batshit's real local web app URL. Do not present this package as the final public installer until the Lane E MacApp story records passing runtime, package, Gatekeeper/notary, DMG install-copy, Docker regression evidence, and full P6 product-surface breadth.
