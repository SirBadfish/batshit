# Registration Patterns

Use this before any `sys.voice.engine.*` mutation. This reference shows the exact Fabric control payloads for registering and managing engines.

---

## The Registration Flow

```
1. Prove the runtime is real and reachable
2. Register (disabled)
3. Health check
4. Smoke test
5. Enable
```

Never register and enable in one step. The disabled registration lets you verify before activating.

## Focused Questions Are Allowed

Default to doing the work, but do not avoid a useful question when it prevents an incomplete install. Ask one to three short questions up front when the answer changes what should be installed or exposed, especially:

- which spoken languages the user wants
- whether to install only English voices or multilingual voices too
- whether the user wants the faster model variant or the quality-first variant
- whether a voice-cloning engine may use a bundled/default reference voice, or whether the user wants to provide authorized reference audio first

Once the answer is clear, proceed. Do not turn research questions into a long interview.

---

## The Local TTS/STT Helper (Preferred Path)

When you already have a verified install root, a real launch command, and a truthful engine payload, prefer `sys.voice.engine.complete_local_setup`:

```json
{
  "controlId": "sys.voice.engine.complete_local_setup",
  "input": {
    "engineId": "kokoro",
    "installRoot": "~/.batshit/installs/kokoro",
    "installOwnership": "batshit-managed",
    "launch": {
      "command": ".venv/bin/python",
      "args": ["main.py"]
    },
    "payload": {
      "name": "Kokoro TTS",
      "baseUrl": "http://127.0.0.1:8880",
      "ttsPath": "/tts",
      "healthPath": "/health",
      "requestFormat": "batshit-byo",
      "supports": { "tts": true, "stt": false, "clone": false },
      "expression": { "strategy": "inline_tokens" }
    }
  }
}
```

This helper runs a fixed sequence:
```
Detached launch → Readiness polling → TTS or STT smoke test
→ Register (disabled) → Post-registration health → Enable
```

### Confirm-Step Rule

This is a `confirm` control. When the confirm gate appears:

1. If the user already approved the setup, retry immediately with `allowRisky: true`
2. Use the same payload — Batshit may cache it for the retry
3. Do **not** switch to manual register/enable calls just because the confirm gate fired

Minimal retry shape:
```json
{
  "controlId": "sys.voice.engine.complete_local_setup",
  "allowRisky": true
}
```

### When to Use Lower-Level Controls Instead

Use `sys.voice.engine.register` / `sys.voice.engine.health_check` / `sys.voice.engine.enable` directly when:
- Connecting to an already-running server (no launch needed)
- Targeted repairs to an existing engine

For local STT installs, the helper fits when you can provide a real short audio sample in `smoke.audioBase64`.

### Local STT Helper Example

```json
{
  "controlId": "sys.voice.engine.complete_local_setup",
  "input": {
    "engineId": "whisper-local",
    "installRoot": "~/.batshit/installs/whisper-local",
    "installOwnership": "batshit-managed",
    "launch": {
      "command": ".venv/bin/python",
      "args": ["server.py"]
    },
    "smoke": {
      "mode": "stt",
      "audioBase64": "<base64 wav bytes>",
      "audioContentType": "audio/wav",
      "expectedText": "hello Batshit",
      "model": "ggml-tiny.en.bin"
    },
    "payload": {
      "name": "Whisper Local",
      "baseUrl": "http://127.0.0.1:8011",
      "sttPath": "/v1/audio/transcriptions",
      "healthPath": "/health",
      "requestFormat": "openai-compatible",
      "supports": { "tts": false, "stt": true, "clone": false },
      "sttDefaults": {
        "modelId": "ggml-tiny.en.bin"
      },
      "sttModelCatalog": {
        "kind": "whisper.cpp",
        "capability": "stt",
        "modelDir": "models",
        "activeModelId": "tiny.en",
        "requiresRestartOnModelChange": true,
        "models": [
          {
            "id": "tiny.en",
            "label": "tiny.en",
            "description": "Fastest English-only starter model; useful for smoke tests and low-latency checks.",
            "language": "en",
            "filename": "ggml-tiny.en.bin",
            "requestModel": "ggml-tiny.en.bin",
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
            "sizeBytes": 78643200,
            "installed": true
          },
          {
            "id": "base.en",
            "label": "base.en",
            "description": "Better English accuracy while still staying quick on Apple Silicon.",
            "language": "en",
            "filename": "ggml-base.en.bin",
            "requestModel": "ggml-base.en.bin",
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
            "sizeBytes": 148897792,
            "recommended": true
          },
          {
            "id": "small.en",
            "label": "small.en",
            "description": "Stronger English accuracy; a practical local upgrade when the machine can spare more memory.",
            "language": "en",
            "filename": "ggml-small.en.bin",
            "requestModel": "ggml-small.en.bin",
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
            "sizeBytes": 488636416
          },
          {
            "id": "medium.en",
            "label": "medium.en",
            "description": "High-accuracy English model; heavier and best treated as an advanced optional download.",
            "language": "en",
            "filename": "ggml-medium.en.bin",
            "requestModel": "ggml-medium.en.bin",
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
            "sizeBytes": 1610612736
          },
          {
            "id": "large-v3",
            "label": "large-v3",
            "description": "Full Whisper large-v3 model for the highest local accuracy; use with language set to English when English-only transcription is desired.",
            "language": "en",
            "filename": "ggml-large-v3.bin",
            "requestModel": "ggml-large-v3.bin",
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
            "sizeBytes": 3168979584
          }
        ]
      },
      "expression": { "strategy": "none" },
      "readiness": { "mode": "health" }
    }
  }
}
```

---

## Apple Silicon Shared MLX Pattern

When `mlx_audio.server` is the shared runtime:

```json
{
  "controlId": "sys.voice.engine.complete_local_setup",
  "input": {
    "engineId": "chatterbox-turbo",
    "installRoot": "~/.batshit/installs/chatterbox-turbo",
    "installOwnership": "batshit-managed",
    "launch": {
      "command": "~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server",
      "args": ["--host", "127.0.0.1", "--port", "8010"],
      "env": {
        "HF_HOME": "~/.batshit/installs/chatterbox-turbo/hf-home"
      }
    },
    "smoke": {
      "model": "mlx-community/chatterbox-turbo-fp16",
      "voiceId": "alloy"
    },
    "payload": {
      "name": "Chatterbox Turbo (MLX)",
      "baseUrl": "http://127.0.0.1:8010",
      "ttsPath": "/v1/audio/speech",
      "healthPath": "/v1/models",
      "requestFormat": "openai-compatible",
      "supports": { "tts": true, "stt": false, "clone": true },
      "ttsDefaults": {
        "modelId": "mlx-community/chatterbox-turbo-fp16",
        "voiceId": "alloy"
      },
      "expression": {
        "strategy": "inline_tokens",
        "supportedTokens": ["[clear throat]", "[sigh]", "[shush]", "[cough]", "[groan]", "[sniff]", "[gasp]", "[chuckle]", "[laugh]"]
      },
      "voiceSurface": {
        "kind": "hybrid",
        "summary": "Chatterbox Turbo MLX exposes one bundled default voice from precomputed conditionals; Batshit clone profiles add user-created voices through ref_audio.",
        "voices": ["alloy"],
        "requiresDiscussion": false
      },
      "voiceDiscovery": { "mode": "none" },
      "readiness": { "mode": "health" }
    }
  }
}
```

Key points:
- `installRoot` is still per-engine
- For Batshit-managed installs, `installRoot` must match the engine ID path Batshit expects, normally `~/.batshit/installs/<engine-id>`. If a variant reuses another runtime, make a lightweight sibling root with symlinks instead of pointing the new engine ID at the old root.
- `launch.logPath` must stay inside the verified install root.
- Launch points at the **shared** MLX executable under `~/.batshit/tools/mlx-audio/`
- The shared MLX runtime does not make Hugging Face caches shared by default. Set `launch.env.HF_HOME` under the per-engine install root, unless the user explicitly approved a shared cache and `launch.env.BATSHIT_ALLOW_SHARED_HF_CACHE = "true"` records that choice.
- `requestFormat: "openai-compatible"` when the MLX server genuinely exposes that contract
- Set `ttsDefaults.modelId` when the server needs a model on every request
- Set `ttsDefaults.voiceId` only when the voice is genuinely valid for this engine
- For Chatterbox Turbo MLX, save only `alloy` as the bundled default voice label; do not publish the generic OpenAI voice list because the model uses bundled conditionals or `ref_audio`, not named OpenAI speakers.
- Keep the requested engine ID — don't invent an `-mlx` suffix
- Only claim clone support when Batshit can actually send the engine's real clone inputs. For Chatterbox/Qwen-style `mlx_audio.server` lanes, Batshit can now replay managed reference-audio profiles through `ref_audio` (and optional `ref_text`) on normal synth requests.
- Keep Hugging Face model IDs out of `launch.args` (they contain slashes that look path-like) — use `ttsDefaults.modelId` + `smoke.model` instead

---

## Pre-Registration Checklist

Run through this before calling `sys.voice.engine.register`:

- [ ] You know the actual request format (`batshit-byo` or `openai-compatible`)
- [ ] You know which capabilities it supports (TTS, STT, clone)
- [ ] You know the expression strategy (from `expression-contract`)
- [ ] You have the real endpoint paths (verified, not guessed)
- [ ] You have auth details in the correct shape if required
- [ ] You know whether voice discovery is real HTTP or manual-entry fallback

If you can't check all of these, you're not ready to register.

---

## Required vs Optional Fields

**Always required:**

| Field | What It Is |
|---|---|
| `name` | Human-readable name for Engine Manager |
| `supports` | `{ tts, stt, clone }` booleans |
| `baseUrl` | Root URL of the engine |
| `requestFormat` | `"batshit-byo"` or `"openai-compatible"` |
| `expression.strategy` | `"none"`, `"instructions"`, `"inline_tokens"`, or `"request_options"` |

**Required when capability is supported:**

| Field | When |
|---|---|
| `ttsPath` | `supports.tts` is true |
| `sttPath` | `supports.stt` is true |

**Recommended:**

| Field | What It Is |
|---|---|
| `healthPath` | Health check endpoint |
| `readiness` | How Batshit determines if the engine is ready |
| `voiceDiscovery` | How voices are discovered (`"http"` when real, otherwise `"none"` or omit) |
| `voiceSurface` | The voices users should see in Batshit's TTS voice dropdown |
| `uiSchema` | Day-to-day advanced TTS/STT engine controls with labels, defaults, and help text |

**Optional — include only when verified:**

| Field | When |
|---|---|
| `authMode` / `authHeader` / `authToken` | Engine requires authentication |
| `voicesPath` | Engine has a real voice-list endpoint |
| `ttsDefaults` / `sttDefaults` | User-facing defaults to set |
| `runtimeCompatibility` | Real platform limits to document |

---

## Voice Catalog and Settings Rule

A complete install includes the engine's practical user-facing surface, not just a health-checking server.

### Voices

Always include bundled/default voices that the engine can actually use:

- If the engine ships a static voice list, publish it in `voiceSurface.voices`.
- If the engine has a real voice-list endpoint, configure and test `voiceDiscovery.mode: "http"` plus `voicesPath`/field mapping.
- If only one default voice exists, still publish it through `ttsDefaults.voiceId` and `voiceSurface.voices`.
- If the engine has no preset voices and only clones from reference audio, say that plainly in `voiceSurface.summary` and do not invent voices.
- If voices are language-specific, include the voices for the user's language scope. For an English-only user, include all English voices. Ask whether they want other language voices when the docs make that choice meaningful.

The TTS voice dropdown is populated from `voiceSurface.voices`, dynamic voice discovery, and saved Batshit clone profiles. Do not make the user ask later for voices that were already listed in the engine docs.

### Practical settings

When the engine documents useful everyday controls, expose them through `uiSchema` and set matching defaults in `ttsDefaults` or `sttDefaults`. Batshit renders those fields in Settings -> Voice -> Voice Engines under the matching Text-to-Speech or Speech-to-Text engine accordion. User overrides are saved in `voice_settings.ttsEngineSettings` or `voice_settings.sttEngineSettings`; the engine record defaults remain the fallback/default values.

Good `uiSchema` candidates:

- sampler steps / inference steps, when the engine explicitly documents the speed/quality tradeoff
- speed, stability, similarity, guidance, speaker-strength, temperature, or format fields when they are safe and documented
- language code when the engine expects one
- model/voice selectors only when Batshit can actually send the value and the runtime can use it

Skip or hide:

- secrets and auth tokens
- internal paths that Batshit manages
- dangerous/debug flags
- fields you have not proven Batshit forwards to the engine
- ultra-advanced controls that will confuse normal voice-chat users

Every exposed field needs:

- a real default in `ttsDefaults`/`sttDefaults` when possible
- `defaultValue` in `uiSchema`
- a short `help` explanation
- `min`/`max`/`step` for numbers when reasonable

Example:

```json
{
  "uiSchema": {
    "sections": [
      {
        "id": "generation",
        "title": "Generation",
        "description": "Common quality and latency controls for this engine.",
        "fields": [
          {
            "id": "num_steps",
            "type": "number",
            "label": "Steps",
            "path": "tts.providerOptions.num_steps",
            "defaultValue": 4,
            "min": 2,
            "max": 16,
            "step": 1,
            "help": "More steps can improve quality but usually increases generation time. Use the engine's documented default unless you are tuning."
          }
        ]
      }
    ]
  }
}
```

---

## Registration by Engine Type

### Local / Self-Hosted Engine

```json
{
  "controlId": "sys.voice.engine.register",
  "input": {
    "engineId": "kokoro",
    "payload": {
      "name": "Kokoro TTS",
      "enabled": false,
      "baseUrl": "http://localhost:8880",
      "ttsPath": "/tts",
      "healthPath": "/health",
      "requestFormat": "batshit-byo",
      "supports": { "tts": true, "stt": false, "clone": false },
      "expression": {
        "strategy": "inline_tokens",
        "supportedTokens": ["[laugh]", "[sigh]"]
      },
      "voiceDiscovery": { "mode": "none" },
      "readiness": { "mode": "health" },
      "runtimeCompatibility": {
        "os": ["darwin", "linux"],
        "arch": ["arm64", "x86_64"],
        "gpu": ["Apple Silicon", "CPU-only"],
        "docker": "not_needed",
        "notes": "Runs on CPU. Faster with Metal on Apple Silicon."
      }
    }
  }
}
```

### OpenAI-Compatible Engine

```json
{
  "controlId": "sys.voice.engine.register",
  "input": {
    "engineId": "local-openai-tts",
    "payload": {
      "name": "Local OpenAI-Compatible TTS",
      "enabled": false,
      "baseUrl": "http://localhost:8000/v1",
      "ttsPath": "/audio/speech",
      "sttPath": "/audio/transcriptions",
      "healthPath": "/health",
      "requestFormat": "openai-compatible",
      "supports": { "tts": true, "stt": true, "clone": false },
      "expression": { "strategy": "instructions" },
      "voiceDiscovery": { "mode": "none" },
      "readiness": { "mode": "health" },
      "ttsDefaults": {
        "modelId": "tts-model-id",
        "common": { "instructions": "Speak in a warm, friendly tone." },
        "providerOptions": { "format": "mp3" }
      },
      "sttDefaults": {
        "modelId": "stt-model-id"
      }
    }
  }
}
```

Key notes for OpenAI-compatible:
- `ttsDefaults.modelId` is the canonical place for a default TTS model
- `sttDefaults.modelId` is the canonical place for a default STT model
- `sttModelCatalog` is the canonical place for local STT model picker/download metadata
- use `sys.voice.engine.model.download` to download a model without switching the active model
- use `sys.voice.engine.model.use` only after the model is installed; for engines that load the model at process start, tell the user a restart is required
- `ttsDefaults.voiceId` is the canonical place for a default voice (Batshit falls back to `alloy` otherwise)
- `ttsDefaults.common.instructions` only if the server actually uses the request `instructions` field. Do not use it for AI writing guidance; TTS engine prompts live separately in Voice Engines and are edited by the user.

### Hosted/API Providers

**Not a speech-setup registration target.** Hosted TTS/STT providers are built-in only — don't register them as `byo:` engines.

---

## Follow-Up Mutations

### Update an Existing Engine

```json
{
  "controlId": "sys.voice.engine.update",
  "input": {
    "engineId": "kokoro",
    "payload": {
      "ttsDefaults": {
        "common": { "instructions": "Use a calm narration style." }
      }
    }
  }
}
```

Only include fields you're changing. Others remain untouched.

### Health Check

```json
{ "controlId": "sys.voice.engine.health_check", "input": { "engineId": "kokoro" } }
```

### Enable / Disable

**Enable only after:** runtime reachable + health passes + smoke test succeeds.

```json
{ "controlId": "sys.voice.engine.enable", "input": { "engineId": "kokoro", "enabled": true } }
```

### Delete

```json
{ "controlId": "sys.voice.engine.delete", "input": { "engineId": "kokoro" } }
```

This also clears global/agent voice selections that pointed to this engine and deletes saved clone profiles created for the deleted BYO provider.

For Batshit-managed local installs only, and only when the user explicitly wants the local engine files removed too, pass:

```json
{ "controlId": "sys.voice.engine.delete", "input": { "engineId": "kokoro", "deleteLocalFiles": true } }
```

Use `deleteLocalFiles: true` only for Batshit-managed installs under `~/.batshit/installs/<engine-id>/`. Connected existing engines and user-managed installs should leave local files alone unless the user removes them outside Batshit.

---

## Common Mistakes

| Mistake | Why It's Wrong | Do This Instead |
|---|---|---|
| Registering with `enabled: true` | Skips verification | Always register disabled, verify, then enable |
| `voiceDiscovery.mode: "http"` without testing | Endpoint might not exist | Test first; use `"none"` if unsure |
| Auth tokens in `uiSchema` | Exposes secrets in browser | Auth goes in `authMode`/`authHeader`/`authToken` (server-side) |
| Guessing `requestFormat` | Wrong format = every request fails | Verify from docs or testing |
| Omitting `expression.strategy` | Batshit doesn't know how to handle expression | Always set one — `"none"` is valid |
| Guessing `runtimeCompatibility` | Creates false limits | Only set real, verified restrictions |
