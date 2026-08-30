# Ports and URLs

This page explains which URLs to use for Batshit, batshit-server, n8n, Docker sidecars, and local runtimes. The most important rule is simple: choose the URL for the thing making the request.

## Quick defaults

| Thing | Browser or host URL | Docker/container URL | Notes |
| --- | --- | --- | --- |
| Batshit app | Mac app: `http://127.0.0.1:5620`; Docker host: `http://localhost:5620`; source dev: `http://localhost:5621` | `http://app:3000` | `5620` is the launch-facing local app port. Source checkout uses an alternate dev port so it can run beside the Mac app. |
| batshit-server | Mac/Docker host: `http://localhost:5600`; source dev: `http://localhost:5610` | `http://batshit-server:5600` | Uploads, helper APIs, and batshit-server health. |
| batshit-server API | Mac/Docker host: `http://localhost:5600/api/v1`; source dev: `http://localhost:5610/api/v1` | `http://batshit-server:5600/api/v1` | Used by helper tooling. |
| n8n | `http://localhost:5678` | `http://n8n:5678` | `http://n8n:5678` only works inside the optional Docker n8n profile network. |
| Redis | Mac app: `localhost:5639`; source-checkout repair: `localhost:6379` | `redis://redis:6379/0` | Docker Redis is internal-only by default. |
| Artifact Complete callback | Mac app: `http://127.0.0.1:5620/api/artifacts/complete`; source dev: `http://127.0.0.1:5621/api/artifacts/complete` | `http://app:3000/api/artifacts/complete` | Server-to-app callback, not a page users open. |
| Mac app streamable MCP helper | `http://localhost:5601/mcp` | not public Docker core | Managed by Runtime Doctor for the Mac app path. |

## Caller rules

Use this table when a URL works in one place but fails somewhere else.

| Caller | Use this URL shape | Example |
| --- | --- | --- |
| Browser on the user's computer using Mac app Batshit | Mac app-owned IPv4 loopback port | `http://127.0.0.1:5620` |
| Browser on the user's computer using Docker Batshit | Host-published localhost port | `http://localhost:5620` |
| Browser on the user's computer using source-checkout dev Batshit | Alternate source dev localhost port | `http://localhost:5621` |
| Batshit app container calling batshit-server | Docker Compose service name | `http://batshit-server:5600` |
| Batshit app container calling optional Docker n8n profile | Docker Compose service name | `http://n8n:5678` |
| Batshit app container calling a host-local service | Docker host gateway | `http://host.docker.internal:11434` |
| Batshit app container calling a sidecar | Docker Compose service name | `http://comfyui:8188` |
| Optional Docker n8n profile calling Batshit | Docker Compose service name | `http://app:3000` |
| Host-managed n8n calling Docker Batshit | Host-published URL plus matching token | `http://127.0.0.1:5620` |
| Docker Agent Browser sidecar calling a host page | Docker host gateway | `http://host.docker.internal:5620` |

If a URL works in the browser but fails from a Batshit agent, it is usually a caller mismatch. `localhost` inside a container means that container, not the user's computer.

## Core health checks

| Service | Health URL |
| --- | --- |
| Batshit app from Mac app browser companion | `http://127.0.0.1:5620/api/health` |
| Batshit app from Docker browser host | `http://localhost:5620/api/health` |
| Batshit app from source-checkout dev browser host | `http://localhost:5621/api/health` |
| Batshit app from Docker network | `http://app:3000/api/health` |
| batshit-server from Mac/Docker browser host | `http://localhost:5600/health` |
| batshit-server from source-checkout dev host | `http://localhost:5610/health` |
| batshit-server from Docker network | `http://batshit-server:5600/health` |
| n8n from browser/host | `http://localhost:5678/healthz` |
| n8n from Docker network | `http://n8n:5678/healthz` |

Docker app and batshit-server health checks include Redis connectivity. If Redis is down or unreachable, health should fail clearly.

## Mac app local ports

These are the launch-facing Mac app defaults:

| Port | Purpose | Override |
| --- | --- | --- |
| `5620` | Batshit app | `BATSHIT_FRONTEND_PORT` |
| `5600` | batshit-server | `BATSHIT_SERVER_PORT` |
| `5601` | streamable MCP helper for Mac app helper tooling | `BATSHIT_MCP_STREAMABLE_PORT` |
| `5678` | n8n editor/webhooks | `N8N_PORT` |
| `5639` | Mac-app-owned Redis | `BATSHIT_MAC_REDIS_PORT`, `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT` |
| `8080` | optional Docker MCP Gateway default for Mac app; source/Docker leave it blank unless configured | `DOCKER_MCP_GATEWAY_PORT` or `DOCKER_MCP_GATEWAY_URL` |

The Mac app Runtime Doctor owns normal Mac startup and status. After `Batshit.app` starts the runtime, `http://127.0.0.1:5620` is also a normal browser companion into that same Mac app instance and data. Public install docs should not send users through private local development launchers.

## Advanced source-checkout repair ports

Manual source-checkout setup is advanced repair/development material, not a normal public install path.

| Port | Purpose | Override |
| --- | --- | --- |
| `5621` | Batshit app for source-checkout dev/repair | `BATSHIT_FRONTEND_PORT` |
| `5610` | batshit-server for source-checkout dev/repair | `BATSHIT_SERVER_PORT` |
| `5611` | streamable MCP helper for source-checkout dev/repair | `BATSHIT_MCP_STREAMABLE_PORT` |
| `5678` | n8n editor/webhooks | `N8N_PORT` |
| `5681` | n8n task-runner broker in the local dev stack | `N8N_RUNNERS_BROKER_PORT` |
| `5682` | n8n task-runner health in the local dev stack | `N8N_RUNNERS_LAUNCHER_HEALTH_CHECK_PORT` |
| `6379` | source-checkout Redis | `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT` |

Source-checkout defaults are intentionally offset from the Mac app's launch-facing ports, so a developer can run Native BS beside `Batshit.app` without fighting for the same listeners or browser cookies. Keep Mac app URLs on `127.0.0.1:5620`; keep source-checkout browser URLs on `localhost:5621` unless you intentionally override them.

## Mac app runtime locations

`Batshit.app` keeps user data outside the app bundle:

| Kind | Location |
| --- | --- |
| Durable data and generated runtime config | `~/Library/Application Support/Batshit` |
| Runtime logs | `~/Library/Logs/Batshit` |
| Cache and scratch data | `~/Library/Caches/Batshit` |

Removing the app bundle does not remove these folders.

Mac app saves write to the Mac-app-owned Redis process immediately. Redis runs with append-only persistence, so recent saved changes are written to disk quickly instead of depending only on delayed snapshot timing.

## Docker core ports

Docker core services are Batshit app, batshit-server, and internal Redis.

| Port | Purpose | Override |
| --- | --- | --- |
| `5620` | Browser-facing Batshit app host port | `BATSHIT_DOCKER_APP_PORT` |
| `5600` | Browser-facing batshit-server host port | `BATSHIT_DOCKER_SERVER_PORT` |
| `6379` | Redis inside Compose only | not published by default |
| `3000` | Batshit app inside Compose | fixed internal app port |
| `5600` | batshit-server inside Compose | fixed internal server port |

Host-published ports bind to `127.0.0.1` by default (`BATSHIT_DOCKER_BIND_HOST`), so only the computer running Docker can reach them. Setting `BATSHIT_DOCKER_BIND_HOST=0.0.0.0` in `.env.docker` exposes the Batshit app, batshit-server, n8n, and optional sidecar ports to your local network — only do that on a network you trust, because Batshit is a single-user app and is not hardened for untrusted LAN access.

Direct Docker Compose commands must use `--env-file .env.docker` when port or public URL overrides are stored in `.env.docker`.

## Docker optional profiles

Optional profiles are not part of the core Docker stack. They start only when the user enables the profile, starts the approved add-on through Batshit with the host operator configured, or connects Batshit to an existing external service.

| Profile or add-on | Browser/host URL | Docker/container URL | Notes |
| --- | --- | --- | --- |
| Optional Docker n8n profile | `http://localhost:5678` by default | `http://n8n:5678` | Optional profile: `n8n`. Host port override: `BATSHIT_DOCKER_N8N_PORT`. |
| Cloudflared | no normal browser UI | targets `http://batshit-server:5600` | Optional profile: `cloudflared`. Metrics default `0.0.0.0:20241` inside sidecar. |
| FBX-to-VRMA worker | no normal browser UI | `http://fbx2vrma-worker:8079` | Optional profile: `fbx2vrma`. Internal worker for Goon Motion Vault FBX uploads. |
| NVIDIA Audio2Face bridge | no normal browser UI | `http://audio2face-bridge:8068` | Optional profile: `audio2face`. Connects to a separate NVIDIA NIM gRPC endpoint, normally `host.docker.internal:52000`. |
| Agent Browser sidecar | no normal browser UI | `http://agent-browser:8091` | Optional profile: `agent-browser`. Uses its own headless Chromium, not host Chrome. |
| LiveKit server | `ws://localhost:7880` | `ws://livekit:7880` for sidecar, `ws://host.docker.internal:7880` for app dispatch | Native managed runtime or optional Docker profile: `livekit`. Also uses `7881` TCP and `7882/udp` for WebRTC. |
| LiveKit agent worker | no normal browser UI | `http://livekit-agent:7899/worker` | Native managed sidecar health uses `http://127.0.0.1:7899/worker`; Docker profile uses `livekit-agent`. |
| ComfyUI validation sidecar | `http://localhost:8188` | `http://comfyui:8188` | Validation sidecar, not a full GPU ComfyUI bundle. |
| Host runtime add-on operator | host helper on `127.0.0.1:5629` | app reaches `http://host.docker.internal:5629` | Prepared by `./start-docker.sh` for Docker Sandbox and approved add-on controls. |

## n8n URL rules

There are three common n8n setups:

| Setup | Browser/editor URL | Batshit app should call |
| --- | --- | --- |
| Mac/local n8n on the same computer | `http://localhost:5678` | `http://localhost:5678` for Mac app Batshit |
| Host-managed n8n used by Docker Batshit | `http://localhost:5678` | `http://host.docker.internal:5678` |
| Optional Docker n8n profile | `http://localhost:5678` or custom host port | `http://n8n:5678` |

For the optional Docker n8n profile, changing `BATSHIT_DOCKER_N8N_PORT` changes only the host/browser port. The n8n container still runs internally at `http://n8n:5678`.

If the optional Docker n8n profile must run beside another n8n on the same machine, use a different host name or port for one of them. For example, use `http://127.0.0.1:5679` for the optional Docker profile so browser cookies do not collide with a native `http://localhost:5678` n8n.

## n8n callback rules

n8n Workflow Subagent callbacks and tool calls must use a Batshit URL reachable from the n8n process. Current official Batshit Subagent Tools calls authenticate with Batshit's short-lived `x-batshit-native-tool-token` payload header, not a static `BATSHIT_TOKEN` credential.

| n8n process | Callback base |
| --- | --- |
| Mac/local n8n beside Mac app Batshit | `http://127.0.0.1:5620` |
| Mac/local n8n beside source-checkout dev Batshit | `http://127.0.0.1:5621` |
| Optional Docker n8n profile | `http://app:3000` |
| Host-managed n8n calling Docker Batshit | `http://127.0.0.1:5620` |

## Local AI and voice runtime URLs

For Docker installs, host-local services usually need `host.docker.internal` when Batshit server-side code calls them.

| Runtime | Mac app URL example | Docker server-side URL example |
| --- | --- | --- |
| Ollama | `http://localhost:11434` | `http://host.docker.internal:11434` |
| LM Studio | `http://localhost:1234` | `http://host.docker.internal:1234` |
| whisper.cpp uploaded-audio STT | `http://localhost:8077` | `http://host.docker.internal:8077` |
| Host BYO TTS engine | `http://localhost:<port>` | `http://host.docker.internal:<port>` |

Realtime browser-direct STT is the exception because the microphone stream starts in the browser. A browser-direct WebSocket for a host service usually stays `ws://localhost:<port>` or `ws://127.0.0.1:<port>`.

## Docker MCP Gateway URLs

Docker MCP Gateway is optional and host-side. It is not part of the core Compose app.

| Caller | URL shape |
| --- | --- |
| Browser/host instructions | `http://localhost:<port>/mcp` |
| Dockerized Batshit app reaching a host gateway | `http://host.docker.internal:<port>/mcp` |

When `DOCKER_MCP_GATEWAY_PORT` or `DOCKER_MCP_GATEWAY_URL` is set in `.env.docker`, `./start-docker.sh` starts the host gateway with the configured token/profile before recreating containers. If the gateway is stopped, core Batshit should still run; Docker MCP tools simply become unavailable or stale until the gateway returns.

## Common port conflicts

- Another app already uses `5620`: change the Mac app `BATSHIT_FRONTEND_PORT` or Docker `BATSHIT_DOCKER_APP_PORT`. Source-checkout dev normally uses `5621`.
- Another source-checkout app already uses `5621`: change `BATSHIT_FRONTEND_PORT` for that source-checkout run.
- Another service already uses `5600`: change the Mac app `BATSHIT_SERVER_PORT` or Docker `BATSHIT_DOCKER_SERVER_PORT`. Source-checkout dev normally uses `5610`.
- Another source-checkout server already uses `5610`: change `BATSHIT_SERVER_PORT` for that source-checkout run.
- Another n8n already uses `5678`: use a different Mac app/source-checkout repair `N8N_PORT` or Docker `BATSHIT_DOCKER_N8N_PORT`.
- A browser can open n8n but Batshit cannot reach it from Docker: set `N8N_API_URL` to the Docker-reachable URL, usually `http://host.docker.internal:5678` for host n8n or `http://n8n:5678` for optional Docker n8n profile.
- A sidecar URL works from the app container but not in the browser: expose a host port and use the browser-facing URL for user-visible links.
