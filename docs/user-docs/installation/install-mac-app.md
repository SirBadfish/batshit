# Install Mac app

The Mac app is the normal Mac setup path. You open `Batshit.app`, use Runtime Doctor to start or repair the local runtime, then open Batshit from inside the app.

Docker remains the cross-platform path. Manual source-checkout setup is advanced repair/development material, not the normal public install.

## Download

[Download Batshit for Mac](https://github.com/SirBadfish/batshit/releases/latest)

The link opens the newest Batshit release on GitHub. Under **Assets**, download the file whose name ends in `-arm64.dmg`, such as `Batshit-0.1.0-alpha.2-arm64.dmg`. The name carries the version, and `arm64` means Apple Silicon Macs. Open the DMG, drag `Batshit.app` to Applications if prompted, then open `Batshit.app`.

To check that the download is intact, also save the `.sha256` file from the same release into the same folder, then run this in Terminal from that folder, using the name of the file you downloaded:

```bash
shasum -a 256 -c Batshit-0.1.0-alpha.2-arm64.dmg.sha256
```

It prints `OK` when the DMG matches.

## Current release truth

The Mac app release path is a Developer ID signed, notarized DMG. Local development builds may still be shared as raw `.app` packages, but the public Mac install path is the DMG.

| Area | Current truth |
| --- | --- |
| App shell | Electron desktop app (its own bundled Chromium) with a packaged Runtime Doctor |
| Local runtime | Packaged Batshit app/server code launched with app-owned runtime binaries when the release package includes them |
| Redis | Mac-app-owned Redis 8 on a Batshit port and Batshit data directory; Runtime Doctor refuses to attach to an unrelated Redis process on that port |
| n8n | Connect existing; not bundled into the Mac app |
| Signing | Public release DMGs are Developer ID signed, notarized, and stapled. Local development `.app` builds may still use local/ad-hoc signing. |
| Distribution | Public release target is a DMG. Local alpha/dev builds may be raw `.app` packages; ZIP is not the default public Mac install path. |

If macOS warns about an unidentified developer, you are using a local development artifact rather than the public signed/notarized DMG.

## Mac app required runtime

Runtime Doctor checks the Mac app's required runtime and reports anything missing. On a healthy launch, the app starts the runtime and opens Batshit automatically; if something needs attention, Runtime Doctor stays visible.

| Requirement | Why Batshit needs it |
| --- | --- |
| macOS on Apple Silicon | Current Mac app and Apple Container proof target |
| App-owned Node 24 runtime | Runs the packaged SvelteKit app/server payload |
| App-owned Redis 8 with the JSON module and `redis-cli` | Stores chats, agents, settings, zips, clips, prompts, and sessions |
| App-owned FFmpeg and FFprobe | Media/Goon previews and Scene-video upload inspection, including software AV1 decoding |
| Apple Container | Default Mac app command sandbox backend on supported Macs |

Normal Mac users should not need to install Node, Redis, or ffmpeg globally for a release package that includes Batshit's managed runtime assets. Local development packages may still report a missing managed runtime if a curated binary was not included in that build; in that case, use the release notes or an advanced repair fallback rather than pointing Batshit at unrelated global services.

Apple Container installs from Apple's signed package. Runtime Doctor links to Apple's official release page when the CLI is missing. Once it is installed, you do not need to start it yourself: Batshit starts it when a sandboxed command needs it. When you quit Batshit, it first removes the sandboxes its own chats left running (quitting in the middle of a reply leaves one). Then it stops Apple Container again if Batshit started it and no other container is running in it. If you started Apple Container yourself, Batshit leaves it running. Batshit never removes a container it did not create.

## Open the app

For a public release build, open the DMG, drag `Batshit.app` to Applications if the DMG asks you to, then open `Batshit.app`. For a local development build shared as a raw `.app`, open `Batshit.app` directly.

Runtime Doctor runs at startup. If the runtime is healthy, it opens Batshit automatically. If the runtime needs attention, Runtime Doctor shows Batshit app health, batshit-server health, Redis health, streamable MCP helper health, missing requirements, data and log folders, and Apple Container status, with an install link when it is missing and a repair action when it does not answer.

Use **Start Runtime** when services are stopped, **Restart** if a service is stuck, and **Open Batshit** once the doctor reports the runtime is ready.

Inside Batshit, Settings → Admin → Runtimes includes **Mac App Required Runtime** when you are using the Mac app. Use **View Runtime Doctor** there any time you want to re-check the same Mac app runtime without relaunching the app.

Batshit opens at:

```text
http://127.0.0.1:5620
```

On first launch, create the first admin account.

## Use a browser window too

After `Batshit.app` starts the runtime, you can also open Batshit in a normal browser at:

```text
http://127.0.0.1:5620
```

That window uses the same Mac app runtime and data as the in-app window — handy when you want Batshit beside n8n, docs, local tools, or other browser tabs.

The Mac app still owns startup, restart, repair, logs, and local data. Browser cookies are separate from the in-app window, so you may need to sign in once in each place. Prefer `127.0.0.1` for the Mac app browser window; `localhost` can collide with advanced source-checkout or development runtimes on the same machine.

## Quitting the app

Closing the Batshit window or quitting the app (Cmd+Q, or Dock right-click → Quit) stops the whole Batshit runtime: the app and server services, the Mac-app-owned Redis process, upload tunnels, any local voice engines Batshit started for you (unless you turned their **Stop with Batshit** switch off), and Docker's `sbx` background service when Batshit started it and no sandbox is running.

The window closes at once, and the Dock icon stays for a few seconds while the services stop. The app closes itself once every managed service has stopped cleanly; you should not need to force-quit it. If anything from an earlier session was left behind — say, after a crash or force-quit — the next launch cleans it up automatically before starting fresh.

Batshit only stops what it started. A voice engine you run yourself, or an `sbx` service you started (for example with `sbx run`), keeps running.

On macOS 27 and later, a light gray dot under an app's Dock icon means something that app started is still running after it quit, and hovering the icon says "Running in Background". For Batshit that is expected only while a voice engine you set to keep running is up. If you see it otherwise, right-click the icon and choose **Stop Running in Background**, then please report it.

If you were using Batshit in a separate browser window, that window stops working after you quit the app, because quitting stops the shared runtime.

## Local data

The Mac app uses normal macOS user locations:

| Data type | Location |
| --- | --- |
| Durable app data and generated runtime config | `~/Library/Application Support/Batshit` |
| Runtime logs | `~/Library/Logs/Batshit` |
| Cache and scratch data | `~/Library/Caches/Batshit` |

Deleting `Batshit.app` does not delete your data. To fully reset a local alpha instance, remove those folders intentionally after exporting any backup you care about.

## n8n

Start with an `API` Primary Agent. Connect n8n when you want workflow tools or n8n Workflow Subagents.

For a local n8n instance, use:

```text
http://localhost:5678
```

Current official n8n templates forward Batshit's short-lived per-message native-tool token, so normal Mac app n8n setup doesn't need a saved Batshit Header Auth credential.

## Optional CLI agent setup

`CLI` agents need the Codex CLI or Claude Code CLI installed, then signed in.

**Easiest path — one-click managed install:** when you set up a `CLI` agent in Settings, Batshit shows an install card for Codex CLI and Claude Code CLI in the model section. Click Install and Batshit downloads an official, checksum-verified copy and manages it for you.

**Bring your own:** if you already installed the CLI yourself (for example `npm i -g @openai/codex`, or Claude Code's official installer), Batshit finds it automatically and keeps using it.

Either way, sign in afterward:

```sh
codex login
codex login status
```

```sh
claude auth login
```

On Windows, Claude Code may print `Paste code here if prompted >` after the browser login. Paste the browser auth code at that prompt, then press Enter. The pasted code may not appear in the terminal, so do not wait for visible text. Do not save or share auth codes in docs or chat.

If Batshit installed the CLI for you, Agent Settings shows the exact sign-in command with the full path — copy and run that one.

Provider API keys saved in Batshit are not the same as CLI login. CLI agents need the CLI itself authenticated.

## Agent command sandboxing

Apple Container is the normal Mac app sandbox backend for agent command execution on supported Macs. Runtime Doctor reports Apple Container status and offers a repair action when it is installed but does not answer. An installed Apple Container that is not running yet is normal: Batshit starts it with the first sandboxed command.

Docker Sandbox remains available as a selectable backup for Mac users who want that backend, and it remains the cross-platform sandbox path for Docker, Windows, and Linux installs. On a Mac it needs Docker's `sbx` tool: see [Set up Docker Sandbox](install-docker.md#set-up-docker-sandbox).

If a sandbox backend is unavailable, Batshit shows an unavailable state instead of silently treating full host shell access as a sandbox.

## Advanced source-checkout repair

Use source-checkout setup only when developing Batshit or repairing a local install issue. Public users shouldn't need this path for a normal install.

The source-checkout pieces are:

- `batshit-app/` for the SvelteKit app
- `batshit-server/server/` for batshit-server
- Redis on `localhost:5639` for the Mac app, or `localhost:6379` for advanced source-checkout repair
- optional n8n on `localhost:5678`

The source-checkout dev/repair ports are intentionally offset from the Mac app's launch-facing ports so both can run on the same Mac:

```env
BATSHIT_FRONTEND_PORT=5621
BATSHIT_SERVER_PORT=5610
BATSHIT_MCP_STREAMABLE_PORT=5611
BATSHIT_SERVER_URL=http://localhost:5610
BATSHIT_SERVER_API_URL=http://localhost:5610/api/v1
PUBLIC_BATSHIT_SERVER_URL=http://localhost:5610
PUBLIC_BATSHIT_SERVER_API_URL=http://localhost:5610/api/v1
BATSHIT_ARTIFACT_COMPLETE_URL=http://localhost:5621/api/artifacts/complete
```

Don't run source-checkout Batshit against the same ports already published by Docker Compose or a running `Batshit.app` runtime.

## Troubleshooting

### Runtime Doctor shows a missing requirement

Use **Refresh**, **Restart**, or Settings → Admin → Runtimes → **Mac App Required Runtime** after fixing the named issue. For a normal release package, missing Node, Redis, or ffmpeg usually means the package is incomplete or damaged, so reinstall Batshit or use a newer package. Advanced source-checkout repair can still use host-installed fallbacks.

### Apple Container has no Linux kernel yet

Apple Container runs each sandbox in a small Linux virtual machine, and it needs a Linux kernel for that. A fresh Apple Container install has none. Batshit does not download one for you, because the download is large. Instead, the first sandboxed command stops with a message that names this step.

Run this once in Terminal:

```bash
container system kernel set --recommended
```

It downloads Apple's recommended kernel (about 600 MB) and makes it the default. Then send your message again. You only need to do this once.

### Port already in use

Batshit expects app `5620`, batshit-server `5600`, streamable MCP helper `5601`, n8n `5678`, and Redis `5639` for the Mac app (`6379` for advanced source-checkout repair). Runtime Doctor refuses to use a Redis process on `5639` unless it is Batshit's Mac-app-owned Redis with the expected data directory. Stop the conflicting process or change the matching env values before starting.

### API keys don't save or decrypt

Check the generated `ENCRYPTION_KEY` in the Mac app runtime config. It must stay stable. If you change it after saving keys, re-enter the keys in Settings → API Keys.

### An n8n Workflow Subagent does not return

Check that the workflow is the current official Workflow Subagent template, that the Batshit Subagent Tools node sends `x-batshit-native-tool-token` from `batshit_native_tool_token`, and that the Batshit URL is reachable from the n8n process.

### Goon or media preview fails

Check Runtime Doctor for FFmpeg status. A normal release package should include app-owned FFmpeg; advanced local-alpha repair can install a host fallback and restart the runtime from Runtime Doctor.

For a Scene video, distinguish an upload/thumbnail error from a playback error after upload. The Mac package's software AV1 decoder handles inspection and thumbnails; Scene playback uses Electron's browser decoder and the Mac's capabilities. Updating a host FFmpeg installation does not add codecs to the packaged app. Use a package with the required decoder for upload errors, and test a separate HEVC/H.265 MP4 copy if AV1 playback is unsupported or slow. Keep the original panorama.

### Mac app setup does not fit your machine

Use the Docker path instead. Docker keeps the core app, batshit-server, and Redis together in Compose and is the normal path for non-Mac machines.

Next: [First run](first-run.md)
