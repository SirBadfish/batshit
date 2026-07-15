# Install Docker

Docker Batshit runs the core stack in Docker Compose: the Batshit app, batshit-server, and Redis Stack. n8n is an optional Compose profile.

Docker is a peer setup path — not a lesser fallback and not the only correct path. It's more contained and reproducible than the Mac app path, while the Mac app stays the richer local workstation path on macOS.

## What the Docker core stack includes

| Service | Included by default | Host URL |
| --- | --- | --- |
| Batshit app | Yes | `http://localhost:5620` |
| batshit-server | Yes | `http://localhost:5600` |
| Redis Stack | Yes, internal only | Not published to host |
| n8n | Optional profile | `http://localhost:5678` |

The Docker app runs internally at:

```text
http://app:3000
```

Other containers use that internal URL when they need to call the app.

## Prerequisites

Install:

- Git
- Docker Desktop or Docker Engine with Compose
- Node 24 and npm on the host, because the Docker launcher is a small Node-powered script

Verify:

```sh
docker version
docker compose version
node --version
```

Node should be version 24 or newer.

## Clone Batshit

```sh
git clone https://github.com/SirBadfish/batshit.git
cd batshit
```

Start from the folder that contains `compose.yaml` and `start-docker.sh`.

On Windows PowerShell, use the Node launcher directly:

```powershell
node tools/docker/start-docker.mjs
```

On macOS, Linux, or a shell that can run repo scripts, use:

```sh
./start-docker.sh
```

## Create `.env.docker`

Copy the example:

```sh
cp .env.docker.example .env.docker
```

Generate two stable secrets:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Open `.env.docker` and replace:

```env
BATSHIT_TOKEN=replace-with-a-long-random-token
ENCRYPTION_KEY=replace-with-a-long-stable-secret-at-least-32-chars
```

with your generated values. Keep both stable after first boot:

- `BATSHIT_TOKEN` is the internal service token used by Batshit, batshit-server, and n8n callbacks.
- `ENCRYPTION_KEY` encrypts saved API keys and custom provider secrets.

The launcher can generate missing placeholder secrets, but setting them yourself makes the boundary explicit and easier to back up.

By default Docker publishes Batshit's ports on `127.0.0.1` (`BATSHIT_DOCKER_BIND_HOST=127.0.0.1`), so only the computer running Docker can reach them. Setting `BATSHIT_DOCKER_BIND_HOST=0.0.0.0` in `.env.docker` exposes Batshit to your local network — only do that on a network you trust, because Batshit is a single-user app and isn't hardened for untrusted LAN access.

## Choose your workspace mount

By default, `./start-docker.sh` fills `BATSHIT_WORKSPACE_MOUNT` with the current checkout path when the value is blank, so `/workspace` inside Docker points at a real host folder.

Use a different host folder if you want Batshit Projects and agents to see a different workspace:

```env
BATSHIT_WORKSPACE_MOUNT=/path/on/your/computer
```

Inside Docker, Batshit sees that folder as:

```text
/workspace
```

Project source files are not copied by Batshit backups. Keep your source in Git or your own backup system.

## Start Docker Batshit

Start the core stack on macOS/Linux:

```sh
./start-docker.sh
```

Or on Windows PowerShell:

```powershell
node tools/docker/start-docker.mjs
```

Open:

```text
http://localhost:5620
```

The launcher prepares `.env.docker`, starts Batshit's Docker Sandbox/runtime add-on host operator, starts the optional Docker MCP Gateway if configured, then runs Docker Compose.

On macOS, the first run may show a system prompt like `"node" would like to access data from other apps`. That's the host-side helper used for Docker Sandbox and approved sidecar start/stop controls. Allow it if you want those features.

The normal Docker start does not start n8n. Existing n8n is first-class; only use the `n8n` profile when you intentionally want Batshit Compose to run a separate local n8n for this instance.

## Start with the optional Docker n8n profile

If you want Batshit to run the Docker n8n profile too:

```sh
./start-docker.sh --profile n8n
```

On Windows PowerShell:

```powershell
node tools/docker/start-docker.mjs --profile n8n
```

Open n8n at:

```text
http://localhost:5678
```

The n8n profile starts an official pinned n8n image and a matching task-runner sidecar. It still requires normal n8n setup: create credentials, import the Batshit workflow templates, configure provider nodes, and create matching n8n agent records in Batshit.

The n8n profile needs one Docker-internal app setting:

```env
N8N_API_URL=http://n8n:5678
```

`./start-docker.sh --profile n8n` fills this automatically when `.env.docker` still has the default host-managed n8n URL. If you use direct Compose, set it yourself before starting the profile. Keep `N8N_EDITOR_BASE_URL`, `WEBHOOK_URL`, and `N8N_WEBHOOK_URL` browser-facing, such as `http://localhost:5678`.

If you already have n8n running on host port `5678`, either stop it or change the Docker n8n host port in `.env.docker` before enabling the profile:

```env
BATSHIT_DOCKER_N8N_PORT=5679
N8N_EDITOR_BASE_URL=http://127.0.0.1:5679
WEBHOOK_URL=http://127.0.0.1:5679/
N8N_WEBHOOK_URL=http://127.0.0.1:5679/webhook
N8N_API_URL=http://n8n:5678
```

Using `127.0.0.1` for one n8n instance can help avoid browser cookie collisions when two local n8n instances are open.

## Advanced direct Compose path

After `.env.docker` is prepared, advanced users can use Compose directly:

```sh
docker compose --env-file .env.docker up -d --build
```

With the n8n profile:

```sh
docker compose --env-file .env.docker --profile n8n up -d --build
```

Before using direct Compose with the n8n profile, make sure `.env.docker` has:

```env
N8N_API_URL=http://n8n:5678
```

Always include `--env-file .env.docker`. Compose needs it for host port and public URL interpolation.

Direct Compose does not run every host-helper preparation step that `./start-docker.sh` does. If Docker Sandbox or approved add-on start/stop controls report `Operator Required`, rerun `./start-docker.sh` or configure the operator manually.

## Start and stop after first creation

Once the Compose project exists, you can start and stop the same already-created containers from Docker Desktop, or use:

```sh
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker stop
docker compose --env-file .env.docker restart
```

If you started profile-backed services like the n8n profile, include the same profile when starting or recreating them:

```sh
docker compose --env-file .env.docker --profile n8n up -d
```

Docker Desktop's Play button resumes existing containers. It does not rebuild images or recreate containers after a Batshit update. Use `./start-docker.sh` again after changing `.env.docker`, Compose profiles, Dockerfiles, package files, or anything that needs containers recreated — it preserves Docker volumes, so saved Batshit data and API keys remain.

When you enable Docker-managed add-ons from Batshit settings — like managed Cloudflared Clip tunnels or LiveKit `Start with Batshit` — Batshit starts them through its approved host operator after the app loads. The core stack may become healthy first, with selected add-ons appearing a moment later.

## Docker URL cheat sheet

Use the URL that matches the caller.

| Caller | Use | Example |
| --- | --- | --- |
| Browser on your computer | Host-published URL | `http://localhost:5620` |
| App container to batshit-server | Compose service URL | `http://batshit-server:5600` |
| batshit-server to app | Compose service URL | `http://app:3000` |
| App container to optional Docker n8n | Compose service URL | `http://n8n:5678` |
| App container to host n8n | Host gateway URL | `http://host.docker.internal:5678` |
| App container to host Ollama or voice engine | Host gateway URL | `http://host.docker.internal:<port>` |
| Browser to host service | Browser URL | `http://localhost:<port>` |

If a URL works in the browser but fails from a Docker agent or app route, it probably needs a Docker caller URL. The full table lives in [Ports and URLs](../reference/ports-and-urls.md).

## Optional profiles and add-ons

The core Docker stack is small. Add-ons are opt-in.

| Profile or route | What it is | Start command |
| --- | --- | --- |
| `n8n` | Optional Docker n8n profile plus n8n runners | `./start-docker.sh --profile n8n` |
| `cloudflared` | Optional sidecar for managed local Clip tunnel URLs | `docker compose --env-file .env.docker --profile cloudflared up -d --build` |
| `fbx2vrma` | Optional worker for Goon Motion Vault `.fbx` conversion | `docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker` |
| `agent-browser` | Optional headless Agent Browser sidecar | `docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser` |
| `livekit` | Optional local LiveKit voice runtime | `./start-docker.sh --profile livekit` |
| `comfyui-validation` | ComfyUI-shaped validation sidecar, not full GPU ComfyUI | `docker compose --env-file .env.docker --profile comfyui-validation up -d --build comfyui-validation` |
| Connect existing | Real ComfyUI, Local AI, voice engines, remote services | Save the reachable URL in Batshit settings |

An add-on listed in `compose.yaml` is a recipe, not a default running service. Batshit agents can start/stop only approved startable add-ons through the authenticated host operator. Connect-existing services are yours to run and maintain.

## CLI agents in Docker (Codex / Claude Code)

The Docker image doesn't ship the Codex or Claude Code CLI. Install them with one click from inside Batshit: open your `CLI` agent in Settings and use the install card in the model section. Batshit downloads an official, checksum-verified copy into a persistent Docker volume, so the install survives container restarts and upgrades. Docker CLI login state is also kept in persistent Docker state after login.

After installing, each CLI must be logged in separately inside the container. Host Codex or Claude login is not copied into Docker. Batshit shows the exact copyable Docker-aware command in Agent Settings — for a Batshit-managed install without the n8n profile, it looks like:

```sh
docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
docker compose --env-file .env.docker exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app /home/batshit-cli/.batshit/installs/cli/bin/claude auth login
```

If you started with the n8n profile, the command includes `--profile n8n`:

```sh
docker compose --env-file .env.docker --profile n8n exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
docker compose --env-file .env.docker --profile n8n exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app /home/batshit-cli/.batshit/installs/cli/bin/claude auth login
```

On Windows, Claude Code may print `Paste code here if prompted >` after the browser login. Paste the browser auth code at that prompt, then press Enter. The pasted code may not appear in the terminal, so do not wait for visible text. Do not save or share auth codes in docs or chat.

Docker Claude runs as the non-root `batshit-cli` user so Claude Code Bypass Permissions can work. If a Docker Claude agent still reports that Bypass Permissions cannot run as root, rebuild the app image from current source and use the exact login command shown in Agent Settings.

Always prefer the command Batshit shows in Agent Settings — it already matches your setup.

## Docker troubleshooting

### App doesn't open

Check container status:

```sh
docker compose --env-file .env.docker ps
```

Check logs:

```sh
docker compose --env-file .env.docker logs app
docker compose --env-file .env.docker logs batshit-server
```

### Saved API keys break after restart

Check that `ENCRYPTION_KEY` didn't change in `.env.docker`.

### n8n callback auth fails

Current official n8n templates use Batshit's per-message `x-batshit-native-tool-token`, so normal native-tool calls don't need a static Docker token in n8n.

### Docker Sandbox says Operator Required

Run:

```sh
./start-docker.sh
```

The public launcher starts the host operator and fills the app's operator URL/token values.

### Project files are missing

Set `BATSHIT_WORKSPACE_MOUNT` to a real host folder, restart/recreate the stack, then use `/workspace` paths inside Batshit.

Next: [First run](first-run.md)
