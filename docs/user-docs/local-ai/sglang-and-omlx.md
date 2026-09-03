# SGLang and oMLX

Two more programs Batshit can talk to: **SGLang**, a serious GPU server, and **oMLX**, an Apple Silicon server built on Apple's MLX framework. Both are connect-existing — you install and run them, Batshit connects.

Neither is enabled by default. Turn one on in **Settings → Local AI** when you actually have it running.

## oMLX

[oMLX](https://github.com/jundot/omlx) is a Mac menu-bar app that serves MLX models over an OpenAI-compatible API. It runs on Apple Silicon (M1 through M5) on macOS 15 or later.

If you're on an Apple Silicon Mac, this is the one worth trying. MLX is Apple's own machine-learning framework, and an MLX build of a model commonly runs meaningfully faster on that hardware than the equivalent GGUF build.

### Setting it up

1. Install oMLX — the signed `.dmg` from its releases page, or the Homebrew tap.
2. Start it. It lives in the menu bar and serves on `http://localhost:8000` by default.
3. Open its admin panel at `http://localhost:8000/admin` and download or point it at a model.
4. In Batshit, go to **Settings → Local AI**, enable **oMLX**, and confirm the base URL.
5. Refresh models. Your oMLX models appear in the Model Catalog.
6. Create a Model Preset using the `direct:omlx` connection.

**Watch the port.** oMLX and vLLM both default to `8000`. See [the port collision section](#two-programs-one-port) below.

### Turn the key check off, or give Batshit the key

oMLX requires an API key on `/v1/*` out of the box, so a fresh install will refuse Batshit with a 401. Two ways to fix it:

- **Simplest for a local-only setup:** in oMLX's admin panel, turn on the option to skip API key verification for localhost. `/health`, `/admin`, and `/docs` already answer without a key; this extends that to the chat endpoints.
- **Or give Batshit the key.** See [Local API keys](#local-api-keys) below. This is the right choice if oMLX is reachable from anywhere but your own machine.

If you get it wrong, Batshit tells you plainly — a 401 shows up as "oMLX refused the request because of its API key", not as a generic connection failure.

### Share one model download with LM Studio

If you already run LM Studio, you do not need a second copy of your models. MLX is the one format both programs can run.

Point oMLX's model directory at LM Studio's:

```text
~/.cache/lm-studio/models
```

Both programs then list the same model, and a 16 GB download stays a 16 GB download. Just don't load it in both at once unless you have the memory to spare — that's roughly double.

### oMLX profiles: let oMLX own the settings

This is the cleanest answer to "can I just keep my settings in oMLX and leave Batshit alone?"

oMLX lets you save a named **profile** — a bundle of sampling settings — against a model, and expose that profile as its own model ID. So `Qwen3.8-27B-MLX-4bit` and `Qwen3.8-27B-MLX-4bit:precise` both show up in the model list as separate entries running on the same loaded model.

Batshit sees both. Pick the profile one, leave every preset field blank, and oMLX's saved settings apply. No extra switch in Batshit needed — [blank already means "you decide"](model-settings.md#blank-means-blank).

Create a profile in oMLX's admin panel (it needs a display name), tick the option to expose it as a model, then refresh models in Batshit.

### What oMLX gives you

- **A cache that survives restarts.** oMLX keeps processed prompts in memory *and* on disk, so a conversation can still be warm after you quit and reopen. It works in 4,096-token blocks — see [why a short chat honestly reports zero](speed-and-caching.md#caches-that-work-in-blocks).
- **Tool calling**, verified working through Batshit.
- **Vision**, on models that support it.
- **Thinking separated from the answer**, so a reasoning model's thinking shows in Batshit's reasoning panel rather than mixed into its reply.
- **Blank presets get the model author's own settings** — oMLX falls back to the model's built-in generation config, which is usually exactly what its author intended.

It also serves embeddings and reranking on the same server, which means one Mac process can cover both chat and [Batshit's memory embeddings](../chat/memory-and-infinite-sessions.md). oMLX additionally offers speech and MCP endpoints; Batshit does not use those today.

**Batshit was tested against oMLX 0.6.4.** It's a young project by a single maintainer, shipping roughly weekly — capable and fast-moving, but not as settled as Ollama or LM Studio. Batshit ships no oMLX code and takes no dependency on it, so if it changes under you, only your connection needs revisiting.

## SGLang

[SGLang](https://github.com/sgl-project/sglang) is a high-throughput inference server aimed at real GPUs. It's cross-platform, and it's the option to reach for if you have a serious graphics card rather than an Apple Silicon Mac.

### Setting it up

1. Install SGLang following its own documentation.
2. Start a server:

   ```bash
   sglang serve --model-path <your-model>
   ```

   Older builds use `python3 -m sglang.launch_server` instead.
3. It listens on `http://localhost:30000` by default.
4. In Batshit, go to **Settings → Local AI**, enable **SGLang**, and confirm the base URL.
5. Refresh models and create a preset on the `direct:sglang` connection.

If you started SGLang with `--api-key`, put that key into Batshit — see below.

### What SGLang gives you

- **Top K, Min P, and Repetition penalty**, all per message.
- **Chat template options**, the standard way to toggle thinking on Qwen and GLM-class models.
- **Cache reporting** — SGLang tells Batshit how many prompt tokens it reused, so the Token Panel shows a real number rather than a note.

**Honest status:** Batshit's SGLang support is built from SGLang's own published API, and everything on Batshit's side is covered by tests — but the Batshit team has not yet run it end to end against a live SGLang server. If something doesn't behave the way this page describes, that's worth telling us about.

## Two programs, one port

oMLX and vLLM both default to port **8000**. That's each project's own choice, and Batshit doesn't override either one — inventing a different default would just confuse anyone reading their documentation.

If you enable both, Batshit shows a warning naming the two programs that collide. Nothing is blocked, and Batshit doesn't quietly list the same models twice under two names.

**The fix is to move one of them.** Both accept any port:

- **oMLX:** change the port in its admin panel or `~/.omlx/settings.json`.
- **vLLM:** start it with `--port 8001`.

Then update the base URL in **Settings → Local AI** to match, and refresh.

Since vLLM ships disabled in Batshit, most people never see this warning at all.

## Local API keys

Every local AI program in Batshit can carry an optional API key. You need one if you run oMLX with its key check on, LM Studio 0.4 with tokens, or vLLM or SGLang started with `--api-key`.

**One key per program, and one place to put it:**

> Settings → API Keys → **Local AI**

All seven programs are listed there, alongside your cloud provider keys. There is deliberately no second field on the Local AI page — one secret with two edit boxes is how they drift apart.

It's encrypted with AES-256-GCM before it touches storage, exactly like every other key in Batshit. It's never shown back to you after saving and never written to a log.

If a program is running but Batshit reports a 401, the Local AI page says so and points you here.

**Memory embeddings use the same key.** If you point Batshit's memory system at a local program for embeddings, it reads the key you already saved. There's no second field to keep in sync — there used to be, and that's now one store.

A program with no key keeps working exactly as before. Leave it blank unless your program is asking for one.

## Related docs

- [Local AI overview](overview.md) — the full program list and basic setup
- [Getting your local model settings right](model-settings.md) — what Batshit sends and what your program owns
- [Why your local model gets faster](speed-and-caching.md) — prompt caching and speed
- [Ports and URLs](../reference/ports-and-urls.md)
