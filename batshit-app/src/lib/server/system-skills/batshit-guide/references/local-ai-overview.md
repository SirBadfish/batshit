# Local AI

Batshit can connect to local AI runtimes so `API` agents use models running on your own computer or network.

Local AI is connect-first. Batshit doesn't bundle local model runtimes or model weights into the core app or the core Docker image.

## Supported runtime families

| Runtime | Default URL | OpenAI-compatible path | Launch posture |
| --- | --- | --- | --- |
| Ollama | `http://localhost:11434` | `/v1` | Managed list/pull/delete where the runtime supports it |
| Docker Model Runner | `http://localhost:12434` | `/engines/llama.cpp/v1` | Managed list/create/delete where available |
| LM Studio | `http://localhost:1234` | `/v1` | Connect existing |
| llama.cpp | `http://localhost:8080` | `/v1` | Connect existing |
| vLLM | `http://localhost:8000` | `/v1` | Connect existing |

Managed means Batshit can do some model management against that runtime. Connect existing means Batshit checks health and lists models, but you start, stop, update, and download models in that runtime's own app or CLI.

## Mac app vs Docker

Mac app Batshit usually uses the runtime's normal local URL, such as `http://localhost:11434`.

Docker Batshit may need the Docker host gateway when the runtime runs on your computer:

| Runtime placement | URL shape for Docker Batshit |
| --- | --- |
| Host Ollama | `http://host.docker.internal:11434` |
| Host LM Studio | `http://host.docker.internal:1234` |
| Same Compose network sidecar | `http://service-name:port` |
| Remote server | normal remote `http://` or `https://` URL |

Batshit can rewrite common loopback URLs for server-side Docker calls, but it's still best to understand the caller. If a URL works in your browser and fails from a Docker agent, try the Docker-reachable URL.

## Basic setup

1. Start your local AI runtime.
2. Confirm the runtime can list models in its own UI or CLI.
3. Open Batshit.
4. Go to Settings → Local AI.
5. Enable the runtime you want to use.
6. Confirm the Base URL and OpenAI path.
7. Click the runtime status/model refresh control.
8. Confirm Batshit sees the model you want.
9. Go to Settings → Models.
10. Create or edit a model preset that uses the local provider connection.
11. Select that preset on an `API` Primary Agent.
12. Send a small text prompt first.

Local provider connection IDs use shapes like `direct:ollama`, `direct:dmr`, `direct:lmstudio`, `direct:llama-cpp`, and `direct:vllm`.

## Model presets

Local models appear in Batshit's Model Catalog and preset pickers after the runtime is enabled and reachable. For local presets:

- Tools default off unless you enable tool support for that preset.
- Local model IDs are preserved as the runtime reports them.
- Vision support depends on the model and runtime, not just on Batshit.
- Image transport can be automatic or forced URL.

If a local model doesn't support tools, leave tools off. A model can be great at chat while being bad or unsupported at tool calling.

## Image and vision setup

Batshit supports two image transport styles for local runtimes:

- **Automatic**: Batshit sends local image clips as structured data URLs when possible.
- **Force URL**: Batshit rewrites image references to URLs the local runtime can fetch.

Automatic is the default, because some local vision runtimes — especially LM Studio setups — reject HTTP image URLs and expect image data in the OpenAI-compatible request.

Force URL is useful when your local runtime must fetch images itself. In that case, set the image base URL to a URL the runtime can reach. For Docker Batshit, a URL image base often needs to point at batshit-server from the runtime's point of view, such as:

```text
http://host.docker.internal:5600
```

There's no hidden retry between image-data and image-URL modes. If the selected transport fails, Batshit shows the failure so you can fix the runtime setup intentionally.

## Ollama notes

Ollama is a good first local runtime — simple local server, simple model management API.

Typical Mac app/host URL:

```text
http://localhost:11434
```

Typical Docker Batshit URL for host Ollama:

```text
http://host.docker.internal:11434
```

After Batshit can list models, create a preset using an Ollama model ID such as `llama3.2:latest` or your chosen installed model.

## Docker Model Runner notes

Docker Model Runner is useful when your local models are managed through Docker Desktop's model tooling.

Typical Mac app/host URL:

```text
http://localhost:12434
```

Typical Docker Batshit URL:

```text
http://host.docker.internal:12434
```

The OpenAI path is usually:

```text
/engines/llama.cpp/v1
```

## LM Studio notes

LM Studio is connect-existing in Batshit.

1. Start the LM Studio local server.
2. Load the model you want in LM Studio.
3. Confirm LM Studio's OpenAI-compatible server is listening.
4. Enable LM Studio in Settings → Local AI.
5. Refresh models in Batshit.

Typical Mac app/host URL:

```text
http://localhost:1234
```

Typical Docker Batshit URL:

```text
http://host.docker.internal:1234
```

For vision models, automatic image transport is often the right first try.

## llama.cpp and vLLM notes

llama.cpp and vLLM are connect-existing runtimes. Batshit expects an OpenAI-compatible API and doesn't manage their process, model files, or GPU settings. Make sure the runtime's `/models` endpoint works before debugging Batshit, then save the base URL and path in Settings → Local AI.

## Agents and Local AI

Local AI is currently for `API` Primary Agents.

`n8n` Primary Agents use whatever model/provider nodes you configure in n8n — if you want n8n to call a local model, configure that inside n8n. `CLI` Primary Agents use their CLI runtime's own model/provider setup; a CLI agent can still call Batshit tools and local services when configured, but local AI model selection isn't the same control path as an `API` model preset.

## Backup boundary

Batshit backups can save Local AI settings and model preset references. They do not include model weights, the Ollama/LM Studio/llama.cpp/vLLM installs, Docker Model Runner model storage, or runtime logs/cache folders.

After restore, reconnect or reinstall the local runtime, refresh models, and reselect presets if a model ID changed.

## Practical test

A small checklist when setting up a local model:

- Runtime is running.
- Batshit status check passes.
- Model list appears in Settings → Local AI or Models.
- Model preset uses the correct local provider connection.
- A simple `API` agent text prompt works.
- If using vision, a small image prompt works with the selected image transport.
- If using tools, the selected model handles one small tool call correctly.

Don't start by testing the hardest multimodal tool workflow. Prove basic text first, then add vision, then tools.
