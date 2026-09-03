# Local AI

Batshit can connect to AI programs running on your own computer or network, so `API` agents use models you host yourself.

Local AI is connect-first. Batshit doesn't bundle these programs or any model weights into the core app or the core Docker image. You install and run the program; Batshit talks to it.

## Supported programs

| Program | Default URL | OpenAI-compatible path | What Batshit can do |
| --- | --- | --- | --- |
| Ollama | `http://localhost:11434` | `/v1` | List, pull, and delete models |
| Docker Model Runner | `http://localhost:12434` | `/engines/llama.cpp/v1` | List, create, and delete models |
| LM Studio | `http://localhost:1234` | `/v1` | Connect existing |
| llama.cpp | `http://localhost:8080` | `/v1` | Connect existing |
| vLLM | `http://localhost:8000` | `/v1` | Connect existing |
| SGLang | `http://localhost:30000` | `/v1` | Connect existing |
| oMLX | `http://localhost:8000` | `/v1` | Connect existing |

Connect existing means Batshit checks health and lists models, but you start, stop, update, and download models in that program's own app or command line.

Ollama and Docker Model Runner are enabled by default. The rest you turn on when you have them.

**SGLang and oMLX are new.** [Their setup page](sglang-and-omlx.md) covers both, including the fact that oMLX and vLLM share port 8000 by default.

## Basic setup

1. Start your local AI program.
2. Confirm it can list models in its own UI or command line.
3. Open Batshit.
4. Go to **Settings → Local AI**.
5. Enable the program you want to use.
6. Confirm the base URL and OpenAI path.
7. Click the status / model refresh control.
8. Confirm Batshit sees the model you want.
9. Go to **Settings → Models**.
10. Create or edit a model preset that uses the local connection.
11. Select that preset on an `API` Primary Agent.
12. Send a small text prompt first.

Local connection IDs use shapes like `direct:ollama`, `direct:dmr`, `direct:lmstudio`, `direct:llama-cpp`, `direct:vllm`, `direct:sglang`, and `direct:omlx`.

## API keys

Every program here can carry an optional API key. You need one if your program is asking for one — oMLX with its key check on, LM Studio 0.4 with tokens, or vLLM or SGLang started with `--api-key`.

Save it in **Settings → Local AI** on that program's card, or in **Settings → API Keys** alongside your cloud keys. It's the same single value either way, encrypted before storage and never shown back to you. Batshit's memory embeddings read the same key, so there's nothing to keep in sync.

Leave it blank if your program doesn't ask for one. Nothing changes.

Full detail is on [the SGLang and oMLX page](sglang-and-omlx.md#local-api-keys), which covers keys for all seven programs.

## Mac app vs Docker

Mac app Batshit usually uses the program's normal local URL, such as `http://localhost:11434`.

Docker Batshit may need the Docker host gateway when the program runs on your computer:

| Where the program runs | URL shape for Docker Batshit |
| --- | --- |
| Host Ollama | `http://host.docker.internal:11434` |
| Host LM Studio | `http://host.docker.internal:1234` |
| Same Compose network sidecar | `http://service-name:port` |
| Remote server | normal remote `http://` or `https://` URL |

Batshit rewrites common loopback URLs for server-side Docker calls, but it's still worth understanding who is calling. If a URL works in your browser and fails from a Docker agent, try the Docker-reachable URL.

## Model presets

Local models appear in Batshit's Model Catalog and preset pickers once the program is enabled and reachable. For local presets:

- **Settings start collapsed and blank.** Blank means Batshit sends nothing and your program decides. Fill a field in and it wins for that message. [Full explanation.](model-settings.md)
- Tools default off unless you enable tool support for that preset.
- Local model IDs are preserved exactly as the program reports them.
- Vision support depends on the model and program, not just on Batshit.
- Image transport can be automatic or forced URL.
- Where the program reports it, Batshit shows the model's **format** (`gguf`, `mlx`, or whatever else it says) and the context size the model is **actually loaded with** — which is often smaller than the model's advertised maximum.

If a local model doesn't support tools, leave tools off. A model can be great at chat while being bad or unsupported at tool calling.

## Image and vision setup

Batshit supports two image transport styles for local programs:

- **Automatic**: Batshit sends local image clips as structured data URLs when possible.
- **Force URL**: Batshit rewrites image references to URLs the program can fetch.

Automatic is the default, because some local vision programs — especially LM Studio setups — reject HTTP image URLs and expect image data in the request itself.

Force URL is useful when your program must fetch images itself. In that case, set the image base URL to something the program can reach. For Docker Batshit, that often needs to point at batshit-server from the program's point of view:

```text
http://host.docker.internal:5600
```

There's no hidden retry between image-data and image-URL modes. If the selected transport fails, Batshit shows the failure so you can fix the setup intentionally.

## Ollama notes

Ollama is a good first choice — simple local server, simple model management.

Typical Mac app / host URL:

```text
http://localhost:11434
```

Typical Docker Batshit URL for host Ollama:

```text
http://host.docker.internal:11434
```

After Batshit can list models, create a preset using an Ollama model ID such as `llama3.2:latest`.

Two things about Ollama are worth knowing before you go far: its OpenAI-compatible endpoint accepts a much smaller set of settings than the other programs, and **it silently shortens conversations that outgrow its context size**. Both are covered, with the fix, in [Getting your local model settings right](model-settings.md#ollama-is-the-odd-one-out).

## Docker Model Runner notes

Docker Model Runner is useful when your local models are managed through Docker Desktop's model tooling.

Typical Mac app / host URL:

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

It runs the llama.cpp engine underneath, so it accepts the same wide set of sampling settings — and it reports prompt cache numbers, which not every program does.

## LM Studio notes

LM Studio is connect-existing in Batshit.

1. Start the LM Studio local server.
2. Load the model you want in LM Studio.
3. Confirm LM Studio's OpenAI-compatible server is listening.
4. Enable LM Studio in **Settings → Local AI**.
5. Refresh models in Batshit.

Typical Mac app / host URL:

```text
http://localhost:1234
```

Typical Docker Batshit URL:

```text
http://host.docker.internal:1234
```

For vision models, automatic image transport is usually the right first try.

LM Studio adds its own instruction paragraph to the front of every prompt it receives, which is worth understanding — see [LM Studio adds its own instructions](model-settings.md#lm-studio-adds-its-own-instructions-to-your-prompt).

## llama.cpp, vLLM, and SGLang notes

These three are connect-existing. Batshit expects an OpenAI-compatible API and doesn't manage their process, model files, or GPU settings. Their settings are launch flags you chose when you started the server.

Make sure the program's `/models` endpoint works before debugging Batshit, then save the base URL and path in **Settings → Local AI**.

llama.cpp accepts the widest set of sampling settings of anything here — DRY, XTC, and Mirostat included. [SGLang has its own section](sglang-and-omlx.md#sglang).

## Agents and Local AI

Local AI is for `API` Primary Agents.

n8n Workflow Subagents use whatever model/provider nodes you configure in n8n — if you want a workflow specialist to call a local model, configure that inside n8n. `CLI` Primary Agents use their CLI's own model and provider setup; a CLI agent can still call Batshit tools and local services, but local model selection isn't the same control path as an `API` model preset.

## Backup boundary

Batshit backups save your Local AI settings and model preset references. They do **not** include model weights, the programs themselves, Docker Model Runner storage, or program logs and caches.

After a restore, reconnect or reinstall the program, refresh models, and reselect presets if a model ID changed.

## Practical test

A small checklist when setting up a local model:

- The program is running.
- Batshit's status check passes.
- The model list appears in **Settings → Local AI** or **Models**.
- The preset uses the correct local connection.
- A simple `API` agent text prompt works.
- If using vision, a small image prompt works with the selected image transport.
- If using tools, the model handles one small tool call correctly.

Don't start by testing the hardest multimodal tool workflow. Prove basic text first, then add vision, then tools.

## Related docs

- [Getting your local model settings right](model-settings.md) — blank fields, per-program settings, the Ollama context trap
- [Why your local model gets faster](speed-and-caching.md) — prompt caching and reading the speed numbers
- [SGLang and oMLX](sglang-and-omlx.md) — the two newest programs, plus API keys and port collisions
- [Troubleshooting voice and Local AI](../troubleshooting/voice-local-ai.md)
