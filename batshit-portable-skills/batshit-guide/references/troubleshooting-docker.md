# Docker troubleshooting

This page covers common Docker Batshit setup problems.

Default launch-facing ports:

- Batshit app: `http://localhost:5620`
- batshit-server: `http://localhost:5600`
- n8n: `http://localhost:5678` when the optional n8n profile is enabled
- Docker internal app URL: `http://app:3000`

## App doesn't open at `localhost:5620`

Check the stack:

```sh
docker compose --env-file .env.docker ps
```

The core services should include `app`, `batshit-server`, and `redis`. Then check health:

```sh
curl http://localhost:5620/api/health
curl http://localhost:5600/health
```

Common fixes:

- Make sure Docker Desktop is running.
- Make sure you started from the folder containing `compose.yaml`.
- Use `--env-file .env.docker` with direct Compose commands.
- Check whether another app already uses port `5620`.
- If you changed `BATSHIT_DOCKER_APP_PORT`, open that port instead.
- Recreate containers after changing `.env.docker`:

```sh
docker compose --env-file .env.docker up -d --build
```

## Docker refuses placeholder secrets

The production Docker runtime requires real, stable secrets. Open `.env.docker` and replace:

```env
BATSHIT_TOKEN=replace-with-a-long-random-token
ENCRYPTION_KEY=replace-with-a-long-stable-secret-at-least-32-chars
```

After changing secrets, recreate containers:

```sh
docker compose --env-file .env.docker up -d --build
```

Don't rotate these casually after you've saved API keys or connected deliberate service-token integrations. `ENCRYPTION_KEY` protects saved secrets; `BATSHIT_TOKEN` is used by batshit-server and trusted helper calls.

## A URL works in the browser but fails from an agent

This is usually a caller problem. Decide which process is making the request:

| Caller | Use |
| --- | --- |
| Browser | `http://localhost:5620` |
| App container calling batshit-server | `http://batshit-server:5600` |
| App container calling optional Docker n8n | `http://n8n:5678` |
| App container calling a host service | `http://host.docker.internal:<port>` |
| App container calling a sidecar | `http://service-name:<port>` |

Examples: host Ollama from Docker Batshit is `http://host.docker.internal:11434`; the n8n profile from the app container is `http://n8n:5678`; batshit-server from the browser is `http://localhost:5600`, but from the app container it's `http://batshit-server:5600`.

Don't fix this by copying random `localhost` URLs between fields. Decide who's calling, then pick the URL.

## Port conflicts

Typical conflicts: another app on Docker's published `5620`, another batshit-server on Docker's published `5600`, source-checkout dev Batshit on its alternate `5621`/`5610` lane, existing n8n on `5678`, LiveKit on `7880`/`7881`/`7882/udp`, or ComfyUI on `8188`.

Move Docker's published ports in `.env.docker`:

```env
BATSHIT_DOCKER_APP_PORT=5620
BATSHIT_DOCKER_SERVER_PORT=5600
BATSHIT_DOCKER_N8N_PORT=5678
```

Then update matching public URLs:

```env
PUBLIC_BASE_URL=http://localhost:5620
PUBLIC_BATSHIT_SERVER_URL=http://localhost:5600
```

Recreate containers after changes. Don't run a source-checkout development stack against the same ports as Docker Compose.

## The optional Docker n8n profile isn't reachable

Start the n8n profile:

```sh
./start-docker.sh --profile n8n
```

Or:

```sh
docker compose --env-file .env.docker --profile n8n up -d --build
```

Check:

```sh
curl http://localhost:5678/healthz
```

If you changed `BATSHIT_DOCKER_N8N_PORT`, use that port in the browser. The n8n container still uses `http://n8n:5678` internally. If you run two n8n instances in one browser, don't open both as `localhost` — cookies collide across ports. Use `127.0.0.1` for one of them.

## n8n callbacks fail auth

Symptoms: the n8n workflow executes but Batshit doesn't stream, n8n logs show unauthorized callback errors, or Batshit receives nothing.

Fix:

1. Confirm the workflow was imported from the current official template.
2. Confirm Batshit Tools sends `x-batshit-native-tool-token` from `batshit_native_tool_token`.
3. Confirm the Batshit Tools URL is reachable from the n8n process.
4. Retest a small workflow.

The n8n profile receives the Docker token automatically at the service level, but your workflow credentials still need to be configured correctly.

## Docker Sandbox says `Operator Required`

Docker Sandbox uses a host-side operator. The core app container doesn't control the host Docker daemon directly.

If you used `./start-docker.sh`, the operator should be prepared automatically. If you used raw Compose, either switch to `./start-docker.sh`, or configure and run the operator yourself, then recreate the app container.

Also check `BATSHIT_WORKSPACE_MOUNT`. Docker Sandbox needs a real host folder mapped to `/workspace`. If `/workspace` is only a named Docker volume, the host operator can't map the same files into a sandbox.

The safe failure is an explicit unavailable/operator error. Batshit won't silently fall back from Docker Sandbox to app-container Bash.

## Bash runs, but it's not my host shell

In Docker, the `local` Bash backend means the Batshit app-container shell. That shell can use `/workspace`, installed container tools, and files mounted into the app container — it is not your host Mac/Windows/Linux shell.

If you need isolated execution, use Docker Sandbox. If you need a host-local tool, install/connect it through a supported runtime path instead of assuming app-container Bash can see it.

## Project files are missing

Mount the project into Docker. In `.env.docker`:

```env
BATSHIT_WORKSPACE_MOUNT=/absolute/path/on/host
```

Inside Batshit/Docker, that appears as `/workspace`. Recreate containers after changing the mount, then create/update the Batshit Project path to use `/workspace/...`. Backup/restore stores Project references, not the source files themselves.

## Codex CLI agent returns `401 Unauthorized`

Provider API keys saved in Batshit don't log the Codex CLI into the app container. Run a container-side Codex login using the exact command Batshit shows in Agent Settings. For a Batshit-managed install:

```sh
docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth
```

If you normally start with `--profile n8n`, include that profile in the command. Then retry the `CLI` agent.

## CLI agent says the CLI isn't installed

The Docker image doesn't ship the Codex or Claude Code CLI. Open the `CLI` agent in Settings and use the one-click install card in the model section. The install is saved in a persistent Docker volume and survives container restarts and upgrades.

## Docker MCP Gateway tools are missing

Docker MCP Gateway is optional and host-side. If `.env.docker` has `DOCKER_MCP_GATEWAY_PORT` or `DOCKER_MCP_GATEWAY_URL`, rerun:

```sh
./start-docker.sh
```

The launcher starts the host gateway when configured. If you run the gateway manually, remember the browser/host URL may be `http://localhost:<port>/mcp`, the app-container URL is usually `http://host.docker.internal:<port>/mcp`, and the token in the gateway and Batshit must match. If you don't need it, leave it disabled — core Batshit doesn't require it.

## Runtime add-on start button is disabled

Possible reasons: the add-on is connect-existing (not startable), the host runtime add-on operator isn't configured, the add-on profile isn't available in this install, or the feature is deferred in Docker.

Use the status/prepare text Batshit shows — it either shows an approved Compose command or explains that the runtime must be connected manually. Don't run arbitrary Docker commands from inside the app container to compensate; start/stop support is intentionally catalog-limited.

## Cloudflared tunnel doesn't start

Docker Cloudflared uses the optional sidecar profile:

```sh
docker compose --env-file .env.docker --profile cloudflared up -d --build
```

The sidecar should target `http://batshit-server:5600` — that's the internal Compose service URL. Don't change it to the host `localhost:5600` unless you're deliberately running a different topology. On macOS, the launcher/operator may trigger a system prompt about `node` accessing data from other apps; allow it if you want Docker Sandbox and approved sidecar Start/Stop controls.

## Audio2Face says Bridge Running but NIM Not Ready

That status is intentional: Batshit's bridge container is healthy, but it cannot reach the separate NVIDIA Audio2Face-3D NIM v2.0 gRPC service. Confirm that the licensed NVIDIA NIM is running on the GPU host and that `BATSHIT_AUDIO2FACE_NIM_ENDPOINT` is reachable from Docker. A host NIM normally uses `host.docker.internal:52000`; a remote NIM needs its reachable host and port. If you enable TLS or mTLS, also check the configured certificate paths.

Batshit does not silently call a different remote service. For an utterance, it reports the Audio2Face failure, tries Rhubarb WASM, then uses text timing only if Rhubarb also fails.

## Agent Browser doesn't work in Docker

Docker Agent Browser uses the optional `agent-browser` sidecar. It does not use your host Chrome profile, cookies, display, or extensions.

```sh
docker compose --env-file .env.docker --profile agent-browser up -d --build agent-browser
```

Use Batshit's Agent Browser settings/tools. Raw app-container Bash commands like `agent-browser open ...` are blocked in Docker.

## Local AI or voice engine can't connect

For host services, use `host.docker.internal` — for example Ollama at `http://host.docker.internal:11434`, LM Studio at `http://host.docker.internal:1234`, or a local TTS HTTP service at `http://host.docker.internal:8077`. Realtime browser WebSocket STT may still need `ws://localhost:<port>` because the browser sends microphone audio directly.

## Backup restore or Goon import is too large

Docker defaults to:

```env
BODY_SIZE_LIMIT=1G
```

This setting applies to app-front-door imports such as Goons, not backup restore. Backup restore streams directly into Batshit's private shared staging volume and shows its own disk-capacity preflight. If restore staging fails, recreate both current app/server containers together and verify `PUBLIC_BATSHIT_SERVER_URL`, `CORS_ORIGIN`, and free disk space. Raise `BODY_SIZE_LIMIT` only for a trusted product import whose own documented cap also permits it.

## Where to look for logs

When Batshit opens, prefer Settings -> Admin -> Diagnostics first. Docker installs use a shared `batshit_logs` volume for Batshit app/server file logs when available, and the diagnostics export previews those logs before download.

If Batshit does not open, use Compose logs:

```sh
docker compose --env-file .env.docker logs app
docker compose --env-file .env.docker logs batshit-server
docker compose --env-file .env.docker logs redis
docker compose --env-file .env.docker logs n8n
```

If you used `./start-docker.sh`, also check the local logs it mentions for host-side operators and optional gateways.
