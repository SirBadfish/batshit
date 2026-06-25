# Choose Mac app or Docker

Batshit has two normal launch paths:

- **Mac app** — for Mac users who want to open `Batshit.app` and let it supervise the local Batshit runtime.
- **Docker** — for users who prefer Docker, need cross-platform setup, or want the core stack in Docker Compose.

Manual source-checkout setup is advanced repair/development material now, not the normal public install path while the Mac app is available.

## Quick choice

| Choose | Good fit when | Tradeoff |
| --- | --- | --- |
| Mac app | You're on a supported Mac and want the most Mac-like setup: open the app, let Runtime Doctor check the Mac app runtime, then use Batshit. | Local alpha/dev builds without curated managed runtime assets may still need repair fallbacks; release packages are intended to own Node, Redis Stack, and ffmpeg. |
| Docker | You want the Batshit app, batshit-server, and Redis in a repeatable Compose stack, or you're not on macOS. | Cleaner core-stack boundaries, but local engines, sidecars, and host services need caller-aware URLs and sometimes a host operator. |

Windows and Linux users should start with Docker. The Mac app is macOS-only.

## What runs where

### Mac app

`Batshit.app` runs Runtime Doctor at startup. When checks pass, it opens Batshit automatically; when something needs attention, Runtime Doctor stays visible. The doctor can start, stop, restart, and check the services the Mac app owns:

- Batshit app on `http://127.0.0.1:5620`
- batshit-server on `http://localhost:5600`
- streamable MCP helper on `http://localhost:5601/mcp`
- Mac-app-owned Redis Stack on `localhost:5639`

Runtime Doctor refuses to attach to an unrelated Redis process on the Mac app Redis port. If something else is already listening there, Batshit reports the conflict instead of quietly using the wrong data store.

After `Batshit.app` starts the runtime, you can also open `http://127.0.0.1:5620` in a normal browser — a second window into the same Mac app instance and data.

Inside the Mac app, Settings → Admin → Runtimes shows **Mac App Required Runtime** for viewing Runtime Doctor checks later. Docker installs do not show Mac-only Apple Container/runtime requirement cards.

The Mac app stores durable state under `~/Library/Application Support/Batshit`, logs under `~/Library/Logs/Batshit`, and cache/scratch under `~/Library/Caches/Batshit`.

n8n is connect-existing for the Mac app. Run your own n8n instance when you want `n8n` Primary Agents or workflow tools.

Apple Container is the Mac app's default sandbox backend for agent command execution on supported Macs. It is not the whole app runtime; it is the isolated command backend used when agents run sandboxed commands. Docker Sandbox remains selectable for Mac users and remains the cross-platform sandbox path.

### Docker

Docker Batshit runs the core stack in Compose:

- `app` container, published to `http://localhost:5620`
- `batshit-server` container, published to `http://localhost:5600`
- internal-only Redis Stack
- optional `n8n` profile, published to `http://localhost:5678`

Inside Docker, services use Docker names: the app calls batshit-server at `http://batshit-server:5600`, batshit-server and n8n call the app at `http://app:3000`, the app calls the optional Docker n8n at `http://n8n:5678`, and the app reaches host services through `host.docker.internal`.

Docker is not just the Mac app launcher inside a container. The core app container doesn't get raw host Docker access by default — Docker Sandbox and approved sidecar start/stop actions use a first-party host operator prepared by `./start-docker.sh`.

## Security and trust

A useful mental model:

- The Mac app is powerful because it runs local services directly on your Mac.
- Docker is more contained for the core app stack, but add-ons and host services still cross boundaries intentionally.
- Sandboxed Agent Mode is the safer normal mode for command execution.
- Full-permission or host-power paths are trusted-user power tools.
- Untrusted Skills, MCP gateways, n8n workflows, Artifacts, and CLI tools can be risky in either path.

Don't expose a local alpha Batshit instance to the public internet unless you know exactly what you're doing with auth, HTTPS, tunnels, reverse proxies, and provider secrets.

## Feature fit

| Feature area | Mac app | Docker |
| --- | --- | --- |
| Basic chat with `API` agents | Good | Good |
| n8n Primary Agents | Good with an existing local n8n using the native official template | Good with the optional Docker n8n profile or existing n8n |
| `CLI` agents | Host CLI login and tools | Container-side CLI login, persistent Docker volume |
| Local AI | Direct `localhost` URLs usually work | Use `host.docker.internal` for host runtimes or service names for sidecars |
| Voice cloud providers | Good with saved keys | Good with saved keys |
| Local voice engines | Connect-existing or approved managed host runtime records | Connect-existing or saved host-runtime launch; not arbitrary installs inside the app container |
| Agent Browser | Host runtime path | Optional `agent-browser` sidecar |
| Command sandboxing | Apple Container by default on supported Macs; Docker Sandbox selectable as a backup | Docker Sandbox through Batshit's host operator |
| Backups | Batshit data export plus your own external runtime backups | Same, plus Docker volumes if you want exact full-instance rollback |

## Which one is for you?

Pick the **Mac app** if:

- You use macOS and want the simplest local Batshit launch.
- You expect to run local AI, local voice engines, Blender, or other host tools.
- You're comfortable with a local alpha app that may still show honest repair guidance if a managed runtime asset is missing from that build.
- You understand local agents may have more access to your machine.

Pick **Docker** if:

- You want a repeatable core app stack.
- You want Batshit, batshit-server, and Redis packaged together.
- You want to isolate core app data in Docker volumes.
- You're comfortable with Docker Desktop, Compose profiles, and caller-specific URLs.

## What to read next

- Mac path: [Install Mac app](install-mac-app.md)
- Docker path: [Install Docker](install-docker.md)
- After either path: [First run](first-run.md)
