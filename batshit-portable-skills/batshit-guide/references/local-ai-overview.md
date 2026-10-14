# Local AI

Batshit can connect to AI programs running on your own computer or network, so `API` agents use models you host yourself.

Local AI is connect-first. Batshit doesn't bundle these programs or any model weights into the core app or the core Docker image. You install and run the program; Batshit talks to it.

## Supported programs

| Program | Default URL | API path | What Batshit can do |
| --- | --- | --- | --- |
| Ollama | `http://localhost:11434` | `/v1` (model discovery; chat uses native `/api/chat`) | List, pull, and delete models |
| Docker Model Runner | `http://localhost:12434` | `/engines/llama.cpp/v1` | List, create, and delete models |
| LM Studio | `http://localhost:1234` | `/v1` | Load and unload models |
| llama.cpp | `http://localhost:8080` | `/v1` | Load/unload models when its server is in router mode; otherwise connect existing |
| vLLM | `http://localhost:8000` | `/v1` | Connect existing |
| SGLang | `http://localhost:30000` | `/v1` | Connect existing |
| oMLX | `http://localhost:8000` | `/v1` | Load and unload models |
| KoboldCpp | `http://localhost:5001` | `/v1` | Switch models (restarts KoboldCpp) |

Connect existing means Batshit checks the connection and lists models, while you start the program and manage its models in that program's app or command line. Some programs also expose specific model controls in Batshit, but each is available only when that installation provides the required API and access.

Ollama and Docker Model Runner are enabled by default. The rest you turn on when you have them.

**Batshit offers model controls for six programs, with conditions.** Ollama, Docker Model Runner,
KoboldCpp, LM Studio and oMLX have their program-specific Models cards in Settings → Local AI.
llama.cpp also has Load/Unload controls when its server reports router mode. A single-model
llama.cpp server, vLLM and SGLang remain connect-only in Batshit; Batshit lists their models but
does not present whole-engine memory controls as per-model unload.

llama.cpp router Load and Unload wait for the program to confirm the change; startup failures remain visible with Retry. If its idle-sleep setting releases the model's memory, the card shows **Sleeping · chat wakes it**, rather than Loaded. A new chat wakes that child automatically; Unload stops it.

**Batshit asks the program, it does not read your folders.** That is on purpose. If Batshit listed
the model files on your disk, it would show you models for programs that cannot load them, and every
one of those would be a dead entry.

Things to know:

- **KoboldCpp restarts itself to change models.** It goes quiet for a few seconds, and Batshit
  waits for it. Model switching requires KoboldCpp's admin mode, an accessible authorized model
  list, and the control entries it provides. Chat and the running-model/context readout work without
  admin model-management access. Batshit tells you when switching is unavailable.
- **A .gguf file loads with KoboldCpp's default settings**, not the ones you started it with. A
  bigger context size, `--jinja`, or `--enableguidance` is dropped. To keep yours, save them as a
  `.kcpps` settings file in the same folder (KoboldCpp's launcher does this with Save Config) and
  pick it under **Settings for Model Files**. Create nonsecret configs before entering credentials: Save Config can store passwords in plain text. **Restore Startup Model** goes back to the model and
  settings KoboldCpp was started with. The card always says what KoboldCpp is running right now.
- **KoboldCpp model and context changes** offer **Model**, **Context Tokens** and **Apply and Restart** on explicitly enrolled same-machine Mac installations. Remote, Docker and unenrolled connections use operator-prepared **Saved KoboldCpp Settings**, whose expected fields only verify the result. Wait for all chats in every client to finish; leave KoboldCpp and its Terminal running. See [Changing the loaded model or context](model-settings.md#changing-koboldcpps-loaded-model-or-context).
- **LM Studio downloads are done in LM Studio.** Newer LM Studio versions have a native download
  API, but Batshit's card manages loading and unloading only. Unload targets the loaded instance,
  which can be different from the model's ID.

- **oMLX model controls need admin access.** An inference API key alone does not grant access to
  oMLX's admin model list or unload action. If its admin list is protected, set up access in oMLX;
  Batshit keeps chat separate from model management.

**KoboldCpp is the newest.** It is one downloaded program file, it runs GGUF models, and it is what
most of the roleplay community uses. Point Batshit at `http://localhost:5001` after you start it.

Two of its features are off until you turn them on when you start it:

- `--enableguidance` turns on negative prompts.
- `--jinja` turns on chat-template options.

Batshit cannot switch these on for you, because they are chosen when the program starts.

**Two things Batshit deliberately does not show you for KoboldCpp.** Mirostat is offered by KoboldCpp
but does nothing on the Mac version we tested — turning it on only switches off Top K and Top P, and
its two dials change nothing at all. And KoboldCpp treats Frequency Penalty and Presence Penalty as
the same setting, so Batshit shows you Presence Penalty only. An empty box is better than a box that
lies.

**KoboldCpp cannot tell Batshit about its prompt cache.** Its replies carry no cache numbers, so the
Token Panel says the count is unknown rather than showing you a zero nobody measured. Its cache still
works; Batshit just cannot see it. Watch the speed numbers instead.

**KoboldCpp does tell Batshit its real context size.** Batshit plans within that allocation and any smaller positive **Context window** saved in your preset. If your
preset says 32,768 but KoboldCpp is running at 12,288, the preset editor says so, and Batshit keeps
your conversation inside the 12,288 KoboldCpp really has. A smaller preset limit stays a smaller planning budget; it does not resize KoboldCpp.

Changing the preset cannot increase KoboldCpp's loaded ceiling. To raise it, restart KoboldCpp with
a larger **Context Size** (`--contextsize`) setting, use the enrolled Local AI context editor, or apply a native saved settings file containing that allocation. Batshit does not send KoboldCpp's
`max_context_length` request extension from a preset.

**KoboldCpp answers every preset with the one model it has loaded**, whatever model the preset names.
After you switch KoboldCpp to another model, a preset saved for the old one still works, but the
replies come from the new one. The preset editor tells you, under Model ID: "KoboldCpp is serving
Llama-3.2-3B-Instruct-Q4_K_M, not the model above." The chat bar and the Token Panel still show the
preset's own name, so check the preset after a switch.

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

Save it in **Settings → API Keys → Local AI**, alongside your cloud keys. That's the one place — there's no second field on this page, on purpose. It's encrypted before storage and never shown back to you. Batshit's memory embeddings read the same key, so there's nothing to keep in sync.

Leave it blank if your program doesn't ask for one. Nothing changes.

Full detail is on [the SGLang and oMLX page](sglang-and-omlx.md#local-api-keys), which covers keys for all eight programs.

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

A disabled program can still show installed model files in Local AI. The Model Catalog explains that it must be enabled before those models appear in preset pickers.

When a program reports its running context, Batshit uses that window to choose a safe **Max Output Tokens** estimate, leaving room for your prompt. A running window of 16,384 tokens gives an estimated output of 8,192. If LM Studio, Ollama, or KoboldCpp cannot report a loaded window, Batshit shows the context limit as unknown rather than using the model's published ceiling or the preset. Programs without a loaded-context reader can use a positive preset only as a labeled estimate. A valid smaller output value you chose is preserved. Context and output edits stay as drafts while you type; leaving the field or pressing Enter formats and validates the completed value before autosave. Invalid token counts stay visible with an explanation. Unsaved drafts remain available when you close and reopen Models within the same app session; failed saves offer Retry Save.

KoboldCpp's Models card shows the loaded model and running context even without admin model-management access. You can chat with that loaded model; the admin notice concerns optional model switching in Batshit.

- **Settings start collapsed and blank.** Most blank fields let your program decide; a value you enter wins for that message. Ollama's Thinking is an exception: **Default (off)** requests thinking off unless Custom Parameters override it. Choose `true` to request thinking. [Full explanation.](model-settings.md)
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

**Ollama vision models require Automatic.** Ollama's native chat API takes image data,
so Force URL is refused with guidance to change the preset or Local AI setting.
Batshit does not download the URL or retry with another transport behind the scenes.

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

Batshit uses Ollama's native API, including its sampler controls and a real **Context size** setting. Ollama still **silently shortens conversations that outgrow that context size**. Set it to fit your model and hardware; see [Getting your local model settings right](model-settings.md#ollama-used-to-be-the-odd-one-out) for the controls and context guidance.

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

llama.cpp keeps its **Detected Models** list in single-model mode. In router mode, Load and Unload wait for the program to confirm the model state; a failed start stays visible with its error. If a model-list read fails, use **Retry**. Changing a saved connection refreshes the card and discards the old connection’s pending result.

These three are connect-existing. Batshit expects an OpenAI-compatible API and doesn't manage their process, model files, or GPU settings. Their settings are launch flags you chose when you started the server.

Make sure the program's `/models` endpoint works before debugging Batshit, then save the base URL and path in **Settings → Local AI**.

llama.cpp accepts the widest set of sampling settings of anything here — DRY, XTC, and Mirostat included. [SGLang has its own section](sglang-and-omlx.md#sglang).

## Agents and Local AI

Local AI is for `API` Primary Agents.

n8n Workflow Subagents use whatever model/provider nodes you configure in n8n — if you want a workflow specialist to call a local model, configure that inside n8n. `CLI` Primary Agents use their CLI's own model and provider setup; a CLI agent can still call Batshit tools and local services, but local model selection isn't the same control path as an `API` model preset.

## Backup boundary

Batshit backups save your Local AI settings and model preset references. They do **not** include model weights, the programs themselves, Docker Model Runner storage, or program logs and caches.

After a restore, reconnect or reinstall the program, refresh models, and reselect presets if a model ID changed. Enroll managed KoboldCpp context editing again; removing and re-adding the connection cannot reactivate its previous local grant.

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
