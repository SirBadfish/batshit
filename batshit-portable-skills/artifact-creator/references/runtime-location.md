# Where the Runtime Lives

**Load when:** the artifact depends on something outside Batshit's own AI: a local runtime (ComfyUI, a model server), a webhook host (n8n or custom), a Gradio or HuggingFace Space, a helper process, or any Docker sidecar. Decide where it runs before you wire URLs.

## Three places a runtime can live

- **Host-managed:** the user already runs it on their machine, and Batshit reaches it by URL.
- **Docker sidecar:** a containerized helper with explicit ports, volumes, environment and secrets, and a health check.
- **Remote service:** reached over a public or private network URL.

Ask the user which they prefer when there is a real choice. Docker users often prefer a sidecar, but do not assume it.

## Docker: one name, different places

When Batshit itself runs in Docker, `localhost` means a different machine to the user's browser, the Batshit app container, batshit-server, n8n, ComfyUI, and the artifact iframe. Record both URLs when they differ:

- **Internal URL:** what Batshit's server-side code calls, such as `http://comfyui:8188` (or `host.docker.internal` for a service on the host).
- **Browser / public URL:** what the user's browser or the artifact iframe opens, such as `http://localhost:8188`.

## Before you register or publish

- Verify the runtime from the side that will call it: server-side URLs from the server, browser URLs from the browser.
- For a Docker sidecar, make sure there is a persistent volume for models, caches, and outputs, the secrets it needs, a health endpoint or test request, restart guidance, and clear failure behaviour.
- If a runtime is unreachable, fail loudly: tell the user which URL failed, from which runtime.

## Batshit runtime add-ons (Docker)

For a supported add-on, check the approved runtime add-on catalog before inventing commands. Search `native_batshit_tool_search` with `family: "fabric"` for `sys.runtime_addon.*`, then use the exact `fabric:` refs for status and prepare; when the host-side operator is configured, approved agents may also start and stop add-ons. n8n-backed agents use `runtime_addon_status`, `runtime_addon_prepare`, `runtime_addon_start`, and `runtime_addon_stop` through the Batshit Tools action. Start and stop go through the authenticated operator; nothing runs arbitrary Docker from inside the app.

## Local model files

Artifact skills never install model weights, clone repositories, or fill local HuggingFace caches. If the user wants something that needs local weights or a local server, route it through the matching runtime or Engine Manager setup so storage and deletion are tracked.
