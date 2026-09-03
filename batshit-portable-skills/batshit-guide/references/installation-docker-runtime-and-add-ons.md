# Docker runtime and add-ons

Docker and the Mac app are peer setup paths. Mac app Batshit is the richer local workstation path on macOS — it works more naturally with host-local tools, runtimes, and desktop authoring apps. Docker Batshit is the more contained, reproducible path — it keeps the core app services packaged together, but optional runtimes need explicit sidecar, host-operator, or connect-existing setup.

Batshit is alpha software for early adopters who are comfortable reporting rough edges, and it's planned as open source under AGPL-3.0-only.

## Core Docker stack

The core Docker stack is small:

- `app`: Batshit web app and app APIs, published on `http://localhost:5620` by default
- `batshit-server`: upload and helper service, published on `http://localhost:5600` by default
- `redis`: Redis 8, which includes the JSON support Batshit stores records with, internal-only by default

Optional services aren't part of the core app container. That includes n8n, Cloudflared, FBX-to-VRMA, Agent Browser, LiveKit, ComfyUI-style services, Local AI runtimes, and voice engines.

## Start Batshit in Docker

From the folder that contains `compose.yaml`:

```sh
cp .env.docker.example .env.docker
```

Open `.env.docker` and replace these placeholders with stable local secrets:

```env
BATSHIT_TOKEN=replace-with-a-long-random-token
ENCRYPTION_KEY=replace-with-a-long-stable-secret-at-least-32-chars
```

Keep both stable after first boot:

- `BATSHIT_TOKEN` lets Batshit, batshit-server, and trusted helper calls authenticate.
- `ENCRYPTION_KEY` encrypts saved provider keys and custom secrets.

Then start Docker Batshit:

```sh
./start-docker.sh
```

On Windows PowerShell, run the same launcher through Node:

```powershell
node tools/docker/start-docker.mjs
```

The launcher prepares `.env.docker` when needed, fills safe local defaults for missing generated values, starts the host-side operator used by Docker Sandbox and approved add-ons, starts the optional Docker MCP Gateway if configured, then runs Docker Compose.

The direct Compose path is also supported:

```sh
docker compose --env-file .env.docker up -d --build
```

Use direct Compose when you're deliberately operating the stack yourself, and always include `--env-file .env.docker` or host port and URL overrides may not apply.

After the Compose project exists, you can start/stop the same already-created containers from Docker Desktop or with:

```sh
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker stop
docker compose --env-file .env.docker restart
```

Docker Desktop's Play button resumes existing containers. It does not rebuild images or recreate containers after a Batshit update. To apply an update, use `./start-docker.sh` or an equivalent `docker compose --env-file .env.docker up -d --build` so containers are recreated from the updated images while volumes stay intact.

Don't use private development launchers as public Docker install commands.

## Optional Docker n8n profile

Existing n8n and the optional Docker n8n profile are both valid. The normal Docker start does not launch n8n; the profile below starts a separate local n8n only when you explicitly choose it:

```sh
./start-docker.sh --profile n8n
```

On Windows PowerShell:

```powershell
node tools/docker/start-docker.mjs --profile n8n
```

Advanced direct Compose path:

```sh
docker compose --env-file .env.docker --profile n8n up -d --build
```

The n8n profile uses port `5678` by default. It runs internally at `http://n8n:5678`; your browser usually opens it at `http://localhost:5678`. It still needs normal n8n setup:

- import the Batshit workflow templates
- create n8n credentials
- configure provider/model nodes in n8n
- activate workflows
- create matching Batshit agents/subagents

Provider keys for n8n workflows belong in n8n credentials, not Batshit-to-n8n key copying.

## URL cheat sheet

Docker has more than one kind of `localhost`. Pick the URL based on who's making the request.

| Caller | Use | Example |
| --- | --- | --- |
| Browser on your computer | Host-published URL | `http://localhost:5620` |
| Browser opening batshit-server uploads | Host-published server URL | `http://localhost:5600` |
| Browser opening the optional Docker n8n profile | Host-published n8n URL | `http://localhost:5678` |
| App container calling batshit-server | Compose service name | `http://batshit-server:5600` |
| App container calling itself | Compose app URL | `http://app:3000` |
| App container calling the optional Docker n8n profile | Compose service name | `http://n8n:5678` |
| App container calling a host-local service | Docker host gateway | `http://host.docker.internal:11434` |
| App container calling a sidecar | Compose service name | `http://comfyui:8188` |

If a URL works in your browser but fails from a Batshit agent, the agent probably needs a different caller URL. [Ports and URLs](../reference/ports-and-urls.md) has the complete reference.

## Important `.env.docker` values

Common launch-facing values:

```env
BATSHIT_DOCKER_APP_PORT=5620
BATSHIT_DOCKER_SERVER_PORT=5600
BATSHIT_DOCKER_N8N_PORT=5678
PUBLIC_BASE_URL=http://localhost:5620
PUBLIC_BATSHIT_SERVER_URL=http://localhost:5600
BODY_SIZE_LIMIT=1G
BATSHIT_WORKSPACE_MOUNT=
```

`BATSHIT_WORKSPACE_MOUNT` controls what host folder appears as `/workspace` inside Docker. To let agents work on real project files, mount the project or repo folder there.

The default `BODY_SIZE_LIMIT=1G` protects ordinary incoming app requests and allows multi-hundred-MB Advanced/Blender Goon imports through the app front door. It does not limit backup export or restore. Exports stream out; restore uses a ticket-bound raw stream into the private shared staging volume and reads large assets from disk.

## Settings and API keys

Open Settings → API Keys after first launch. Provider keys are normal user-entered keys — add keys for the providers you want Batshit to use directly.

Core Infrastructure rows are different in Docker:

- Batshit Internal Token is managed by `.env.docker` and Compose. Current official n8n templates use scoped per-message native-tool tokens, so most users do not need to copy this value. Rotate it by editing `.env.docker` and recreating/restarting containers.
- Artifact Complete URL normally uses the Docker default; a blank saved value doesn't mean artifact callbacks are broken.
- Docker MCP Gateway Token appears only when the optional gateway is configured.
- n8n URL reflects the effective Docker runtime route.
- n8n API Key and n8n Instance MCP Token are optional, only needed for n8n API/MCP integrations.

If a row is runtime-managed, change the env file and restart/recreate the containers instead of trying to edit the value inside the app.

Settings-selected Docker add-ons don't rewrite shell scripts — Batshit stores those choices in its app data. On startup the launcher prepares the core stack plus the approved host operator; after the signed-in app loads, Batshit reads settings like managed Cloudflared auto-start and LiveKit `Start with Batshit`, then asks that operator to start the selected sidecar/profile.

## Docker Sandbox

Dockerized Batshit supports two command paths:

- **App-container Bash**: commands run inside the `app` container against `/workspace`.
- **Docker Sandbox**: Batshit's isolated command backend, backed by a host-side operator.

App-container Bash is useful, but it's not your host computer shell and it's not the same thing as Docker Sandbox isolation.

The normal `./start-docker.sh` launcher prepares and starts the host operator. If you bypass the launcher and use raw Compose, Docker Sandbox may show `Operator Required` until you configure the operator URL, token, and workspace mapping yourself.

Batshit does not mount the host Docker socket into the core app container by default. That's intentional.

## Codex / Claude Code CLI in Docker

The Docker app image doesn't ship the Codex or Claude Code CLI. Install them with one click from inside Batshit: open your `CLI` agent in Settings and use the install card in the model section. The install lands in a persistent Docker volume (`batshit_agent_runtime`), so it survives container restarts and image upgrades. Docker CLI login state is also kept in persistent Docker state after login.

After installing, each CLI still needs a container-side login before `CLI` agents can use it. Use the exact command Batshit shows in Agent Settings. For a Batshit-managed install, from the folder containing `compose.yaml` and `.env.docker`:

```sh
docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
docker compose --env-file .env.docker exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app /home/batshit-cli/.batshit/installs/cli/bin/claude auth login
```

If you started the n8n profile and your Compose command normally includes `--profile n8n`, include that profile in the login command too.

On Windows, Claude Code may print `Paste code here if prompted >` after the browser login. Paste the browser auth code at that prompt, then press Enter. The pasted code may not appear in the terminal, so do not wait for visible text. Do not save or share auth codes in docs or chat.

Docker Claude runs as the non-root `batshit-cli` user so Claude Code Bypass Permissions can work. If a Docker Claude agent still reports that Bypass Permissions cannot run as root, rebuild the app image from current source and use the exact login command shown in Agent Settings.

An unauthenticated Codex run can reach the real CLI and still fail with an OpenAI `401 Unauthorized`. In that case the missing step is usually container-side Codex login, not provider keys saved in Batshit.

## Runtime add-on shapes

Batshit uses four add-on shapes:

- **Connect existing**: you already run a service and give Batshit the reachable URL.
- **Docker sidecar or worker**: Batshit ships a known Compose profile for that service.
- **Host operator**: a narrow host-side helper starts/stops approved add-ons for Admin or permissioned agents.
- **Deferred**: the feature isn't launch-supported in Docker yet and shows a clear unavailable state.

An add-on listed in `compose.yaml` is an opt-in recipe. It's not automatically running and not bundled into the core app container. Permissioned agents can list/check/prepare approved add-ons. Start/stop only works for approved startable entries and requires the authenticated host operator; connect-existing entries refuse start/stop and explain setup instead.

## Current add-on status

| Add-on | Docker launch posture |
| --- | --- |
| Optional Docker n8n profile | Optional `n8n` profile. Manual n8n workflow/credential setup still required. |
| Cloudflared | Optional `cloudflared` sidecar for managed Clip tunnel URLs. |
| FBX-to-VRMA | Optional `fbx2vrma` worker for Goon Motion Vault `.fbx` uploads. |
| NVIDIA Audio2Face bridge | Optional `audio2face` bridge for a separately installed and licensed NVIDIA Audio2Face-3D NIM v2.0 GPU runtime. Batshit does not bundle NVIDIA's NIM, models, or license. |
| Agent Browser | Optional `agent-browser` sidecar/controller with headless Chromium. |
| LiveKit | Optional `livekit` voice runtime profile with LiveKit server plus Batshit agent worker. |
| `comfyui-validation` | Optional validation sidecar for ComfyUI-shaped artifact routing. Not full GPU ComfyUI. |
| Real ComfyUI/Gradio-style runtimes | Connect existing for launch unless a future approved sidecar ships. |
| Local AI | Connect existing. Batshit doesn't bundle Ollama, Docker Model Runner, LM Studio, llama.cpp, vLLM, SGLang, or oMLX. |
| Voice engines | Connect existing, or saved host-runtime launch through the operator. No arbitrary speech-engine containers at launch. |
| Docker MCP Gateway | Optional host-side gateway. Not part of the core Compose app. |

## Start common add-ons

Cloudflared:

```sh
docker compose --env-file .env.docker --profile cloudflared up -d --build
```

FBX-to-VRMA worker:

```sh
docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker
```

Audio2Face bridge, after the separate NVIDIA NIM is running and its gRPC endpoint is configured in `.env.docker`:

```sh
docker compose --env-file .env.docker --profile audio2face up -d --build audio2face-bridge
```

The bridge's Admin status separates `Bridge Running` from `NIM Ready`. A healthy bridge with an unavailable NVIDIA NIM is not ready for analysis. Completed-utterance animation results are cached in a dedicated Docker volume; NVIDIA images, model caches, TLS files, and GPU state remain external to Batshit backup/restore.

Agent Browser sidecar:

```sh
docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser
```

LiveKit runtime:

```sh
./start-docker.sh --profile livekit
```

On Windows PowerShell:

```powershell
node tools/docker/start-docker.mjs --profile livekit
```

Advanced LiveKit direct Compose:

```sh
docker compose --env-file .env.docker --profile livekit up -d --build livekit livekit-agent
```

ComfyUI validation sidecar:

```sh
docker compose --env-file .env.docker --profile comfyui-validation up -d --build comfyui-validation
```

These commands start known Batshit profiles. They do not give the app container arbitrary Docker control.

## Local AI from Docker

Local AI runtimes aren't bundled in the core Docker image. If Ollama runs on your host at `http://localhost:11434`, Docker Batshit normally reaches it as:

```text
http://host.docker.internal:11434
```

The same idea applies to LM Studio, Docker Model Runner, llama.cpp, vLLM, SGLang, and oMLX. Save the URL the Batshit app container can reach, then use Settings → Local AI to check status and list models.

## Voice engines from Docker

Cloud voice providers work from Docker when their keys are saved.

Host-style local TTS/STT engines aren't installed from inside the core Docker app container. Use Settings → Voice → Voice Engines → Installed Engine Controls → Connect Existing when the engine already runs on the host, another container, or another machine.

For server-side TTS and uploaded-audio STT, a host engine usually uses a Docker URL like:

```text
http://host.docker.internal:8077
```

Browser-direct realtime STT is different, because microphone audio starts in the browser. A host WebSocket usually needs to stay browser-reachable:

```text
ws://localhost:8078
```

LiveKit bridge-mode BYO realtime STT starts from the LiveKit sidecar, so loopback WebSocket URLs are rewritten to `host.docker.internal` for that path.

## LiveKit is a voice runtime

LiveKit is not a TTS engine or an STT engine — it's an optional realtime voice runtime.

Docker users can use `./start-docker.sh --profile livekit` for the local Docker LiveKit add-on, or connect an external LiveKit server or LiveKit Cloud with URL/API credentials. Non-Docker Mac/Linux users can install the managed local LiveKit runtime from Settings → Voice → Voice Engines → Voice Runtimes, or connect an external server/Cloud.

LiveKit is optional. Normal voice can use direct Batshit STT/TTS paths without it.

## Backup boundary

Batshit Admin backups include Batshit-owned Redis records and uploaded files. They don't silently include:

- external n8n workflows or credentials
- project source folders
- Local AI model weights
- installed voice engine runtimes or model files
- LiveKit servers/workers
- Cloudflared runtime state
- Agent Browser sidecar browser cache
- Docker Sandbox state
- ComfyUI or other external runtime data unless a future add-on explicitly says otherwise

Use each external tool's own backup/export process when you need exact external runtime recovery.

## Safe operating rules

- Don't run a source-checkout development stack against ports already owned by Docker Compose.
- Keep `BATSHIT_TOKEN` and `ENCRYPTION_KEY` stable after first boot.
- Recreate containers after changing env values that Compose bakes into the container environment.
- Mount real project folders into `/workspace` before expecting agents to edit them.
- Treat imported Skills, workflows, MCP gateways, Artifacts, and scripts as code from outside your instance. Read them before running them.
