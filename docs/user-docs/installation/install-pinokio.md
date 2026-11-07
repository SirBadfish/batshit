# Install with Pinokio

[Pinokio](https://pinokio.co) installs and runs local AI apps with one click. This guide covers Batshit’s Pinokio launcher on **macOS on Apple silicon (M1 or newer)** and **Windows x64 with WSL 2 already enabled**. It runs Batshit’s core app on your computer without requiring Docker.

On **Windows x64**, the launcher uses Batshit's own WSL 2 Linux environment. This route is included in the public alpha3 release. For Linux, use [Docker](install-docker.md) for now.

## Before you start

- Pinokio **8.2**, the version used for this release’s installation checks.
- Free disk space for Batshit, its dependencies and your data. Windows also stores a dedicated Linux disk. Voice engines and model downloads need additional space.
- Ports **5650**, **5651**, and **5659** free on your computer.
- Windows: a working **WSL 2** installation with virtualization available before you start. First-time Windows prerequisite setup is outside the tested path in this guide. If you still need it, follow [Microsoft’s WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install), including any required restart, before importing Batshit.

## Install

1. From Pinokio’s home screen, open **Create**. On Mac, choose **Create app**, then the **Download** tab; on Windows, open **Download**.
2. Enter `https://github.com/SirBadfish/batshit` as the **Git URL**, enter `batshit` as the **Folder name**, then click **Import**.
3. Open **Batshit** in Pinokio and click **Install** if it has not started automatically. Let the installation finish; the first Windows install also prepares its Linux environment.
4. Batshit may start automatically after installation. If it is stopped, click **Start**. When the ready menu appears, click **Open Batshit**. If Pinokio shows **Click to open in browser**, click that too. Batshit opens at `http://127.0.0.1:5650`.
5. Create your admin account, then follow [First run](first-run.md).

**Open Batshit** opens your browser. Keep Pinokio running while you use Batshit.

If Install offers to enable Windows prerequisites, WSL2 is not ready yet. This guide assumes those prerequisites are already working. Finish the Microsoft setup first, then return to **Install**.

Once Windows prerequisites are ready, **Install** prepares Batshit's Linux environment and application automatically; normal use needs no terminal commands. Let Pinokio install its required development tools if it asks. If the launcher reports that its required Batshit release is unavailable, use **Update** or try again later.

If an unfinished Windows install has retained Batshit's environment, its menu also offers **Update** to pick up a newer repaired release. **Install** retries the current release. Both keep the existing disk and data.

## What Install downloads

- The Batshit release the launcher names (a release tag, never unreleased code), from GitHub.
- Batshit's Node.js packages, exactly as the release's lockfile pins them, from npm.
- Redis 8.10.1 with the JSON and search modules, from Redis's own download site (`packages.redis.io`), checked against a pinned checksum. On Linux it also downloads one small library from Ubuntu's archive (`libcrypt1`), checked the same way.

On Windows, the launcher creates its own Linux environment and preserves your existing distributions. Normal Batshit use runs under an unprivileged account. If you had no Linux distribution before, Windows may select Batshit’s environment as its default.

## Where your data lives

Pinokio creates a separate Batshit instance. It does not automatically reuse your existing Mac app or Docker data.

Your chats, agents, uploads, saved API keys, and Batshit's database live in `~/.batshit/pinokio`, outside Pinokio's folder. That folder also holds `batshit.env`, the two secrets Batshit made at install. One of them unlocks the API keys you save: keep it, and back it up with your other files. Make Batshit backups in **Settings → Admin → Backup**.

If `batshit.env` goes missing while saved data remains, restore the original file. Install refuses to create replacement keys over your saved files because a new encryption key cannot unlock them.

On Windows, your data is inside Batshit’s Linux disk, stored under `%USERPROFILE%\.batshit\pinokio-wsl`, outside the downloaded repository. **Update**, **Install** and **Reset** preserve that disk, your data and keys. Removing the downloaded Pinokio app folder does not remove the Linux disk. Make a Batshit backup before deliberately deleting data; see [Backup and restore](../admin/backup-and-restore.md).

## Pinokio's buttons

| Button | What it does |
| --- | --- |
| **Start** | Starts Batshit's database, file server, and app, in that order. |
| **Stop** (Pinokio's stop button) | Stops Batshit's app, file server and database. Finish active work first. Engines added with **Connect Existing** remain under their own application's control; stop those from their own Pinokio apps when needed. |
| **Update** | Moves to the newest Batshit release and rebuilds it. Your data stays. |
| **Install** | Installs again, for example after Reset. Your data stays. |
| **Reset** | Removes Batshit’s generated runtime and build files so you can reinstall. Your data stays; on Windows its Linux disk is retained. |
| **Delete Batshit data** | Deletes this installation’s data folder, including chats, agents, uploads, saved keys and any managed runtime files inside it. It asks you to type `DELETE` and works only while Batshit is stopped. Deletion refuses when an engine or sandbox it owns is still in use or cannot be checked; follow the message instead of removing files manually. It cannot be undone. |

On Windows, **Stop** can end the local voice engines running inside Batshit's Linux environment. Those engines cannot stay running after the environment ends, even if a saved preference says otherwise; Settings explains that limit. An engine running separately in another Pinokio app stays under that app's control. Let active work finish before stopping Batshit.

Windows-host model servers, MCP tools and project paths remain distinct from Linux. A Windows `localhost` address or `C:\...` path is not automatically a Linux address/path. Batshit does not expose or reconfigure Windows services or silently change saved connections; an external runtime must have a supported reachable configuration.

## Use a voice engine you already run in Pinokio

You do not need a second copy of an engine just because Batshit was installed separately. If your engine exposes a speech API that Batshit supports, use **Connect Existing**:

1. Start the voice engine in its own Pinokio app.
2. Find its API address, supported request format and health endpoint in the engine's documentation. Its web interface address alone may not be a speech API.
3. In Batshit, open **Settings → Voice → Voice Engines → Installed Engine Controls → Connect Existing**.
4. Enter the engine's address and API settings, and save it disabled.
5. Run **Health Check**, then one short synthesis or transcription test. Enable it after that test succeeds.

Pinokio keeps control of that engine's installation and running process. Batshit does not automatically discover all Pinokio apps, take over their files, or start and stop an engine added with Connect Existing. Stop it from its own Pinokio app when you finish.

On macOS, a service on the same computer can usually use its local address. For Linux Docker, use the Docker-specific address in [Voice settings](../voice/voice-settings.md); `localhost` inside the container is not your computer. On Windows, Batshit calls the service from WSL2, so a Windows-only `localhost` address may not be reachable. Use an address supported by the engine and your [WSL networking setup](https://learn.microsoft.com/en-us/windows/wsl/networking); changing the address in Batshit does not make a loopback-only service reachable. A different networking mode is a computer-wide configuration change, not something Batshit enables for you. Do not expose the engine publicly just to connect it.

## Optional runtime limits

This guide covers the core install and **Connect Existing**. For local voice engines, start and stop them in their own Pinokio apps. Automatic management of Batshit-launched engines and sandbox-service lifecycle have not yet been verified for this Pinokio setup. Existing controls are unchanged; these advanced cases need separate qualification.

LiveKit is optional realtime voice infrastructure. It is not needed for ordinary text-to-speech or uploaded-audio transcription. Managed LiveKit installation and native speech-to-speech presets, such as OpenAI Realtime, are outside the supported Pinokio setup in this guide. An external LiveKit server or LiveKit Cloud is an advanced alternative, but it also requires Batshit’s voice worker; the server URL alone is not enough. See [Voice settings](../voice/voice-settings.md) for engine configuration and the separate LiveKit options.

## If something goes wrong

- **Install stops at a download:** check your connection and retry **Install** once the download service is reachable. Keep the existing install and data; you do not need to reset them for a failed download.

- **"Port 5650 is in use"** (or 5651, 5659): another program uses a port Batshit needs. The message names the program when it can. Close it, press Pinokio's stop button, then click **Start** again. Batshit never moves to other ports, because your sign-in is tied to its address.
- After any error, Pinokio keeps Start marked as running until you press its stop button.
- **Start stops with "Batshit's database stopped"**: the lines just above it are the end of the database's log, and they say why. The whole log is `~/.batshit/pinokio/logs/redis.log` (the start before is in `redis.previous.log`). In that log, **"Possible SECURITY ATTACK detected"** is harmless: Pinokio checks which local ports serve web pages, and Batshit's database turns that check away.
- **"The release … is not published yet"**: the launcher names a release that GitHub does not have yet. Try again later.
