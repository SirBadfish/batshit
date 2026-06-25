# Apple Silicon + MLX-Audio

Use this when:
- Machine is `macOS` on `arm64` (Apple Silicon)
- User wants local TTS
- The requested engine has a **verified** `mlx-audio` path

This is a special local-engine lane. It ends in a normal Engine Manager record, but the runtime shape is different: one **shared** Batshit-managed MLX runtime for Apple Silicon, plus one per-engine install root for helper state and logs.

Don't treat this like the normal "clone a repo and build a new `.venv` per engine" path unless you have a concrete reason to fall back.

---

## What Counts as "Verified"

Don't offer MLX just because someone said it exists. Verify:

1. Check the official `mlx-audio` supported-model list first
2. If not listed, search `mlx-community` on Hugging Face
3. Only continue if the model card shows clear `mlx_audio` usage or explicit `mlx-audio` server examples

If you can't find that proof, don't pitch MLX. Fall back to `local-self-hosted-engines`.

**Nuance:** `mlx-community` presence is a strong signal, not a blank check. Some model cards prove CLI usage but not every server feature. Only advertise what Batshit can actually send through the current transport.

---

## Shared Runtime Policy

For Batshit-managed Apple Silicon MLX:

| What | Where |
|---|---|
| Shared runtime | `~/.batshit/tools/mlx-audio/` |
| Shared venv | `~/.batshit/tools/mlx-audio/.venv/` |
| Per-engine state | `~/.batshit/installs/<engine-id>/` |

**Do:**
- Install `mlx-audio` into the shared root
- Keep each engine's helper state, logs, and metadata in its own engine root

**Don't:**
- Install `mlx-audio` into system Python
- Build a fresh MLX venv inside every engine folder
- Skip the per-engine root — the helper still needs it

---

## Working With Existing Installs

### Batshit-Managed Shared Runtime Already Exists

If `~/.batshit/tools/mlx-audio/` already exists, do one **fast health gate**:

1. Confirm Apple Silicon
2. Confirm the shared executable/import exists
3. At most one quick version check if model compatibility is unclear
4. `mlx_audio` import + `mlx_audio.server --help` = healthy enough

Then **stop auditing** and move into the engine-specific helper flow. Don't keep re-checking with `pip show`, `pip list`, or bin-directory listings.

If slightly broken but salvageable (e.g., `pip` missing from the venv), repair it once and move on.

**Known bootstrap repair on Apple Silicon:**
- The first install may hit: missing `webrtcvad` → missing `pkg_resources` (pin `setuptools<81`) → missing `fastapi`/`python-multipart`
- For Kokoro on some current macOS installs, `python3` (`3.13.x`) is too new — use `python3.12` instead
- Handle as one repair lane, not separate user-facing blockers
- Don't call `sys.voice.engine.complete_local_setup` until `~/.batshit/tools/mlx-audio/.venv/bin/python` exists and `mlx_audio.server --help` succeeds

### User-Managed Install Exists

Reuse only after verification:
- Confirm Apple Silicon
- Confirm executable/import exists
- Confirm version is recent enough
- Confirm one real smoke request succeeds

Don't silently mutate a user-managed MLX install. If you need to update it, say so first.

### Fresh Batshit-Managed Install

```bash
mkdir -p ~/.batshit/tools/mlx-audio
python3 -m venv ~/.batshit/tools/mlx-audio/.venv
~/.batshit/tools/mlx-audio/.venv/bin/pip install -U pip
~/.batshit/tools/mlx-audio/.venv/bin/pip install -U mlx-audio
```

Verify the server command exists before moving on:
- `~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server`

**`uv` note:** Don't assume Batshit owns `uv`. If global `uv` reports a platform mismatch on arm64, switch to `python3 -m venv`. For `python3 -m venv`, this is the safest default when tool provenance is unclear.

---

## Support Conversation

Once verified, tell the user:

> *"You're on Apple Silicon, and this engine has a verified MLX path. MLX is usually the best local option on Macs — built for Apple Silicon. I can use a shared Batshit-managed MLX runtime so we don't need a separate Python environment for every MLX-capable engine."*

Then make the decision explicit:
- MLX? Continue here.
- Native? Switch to `local-self-hosted-engines`.

Present MLX as the likely default on Apple Silicon, not a requirement.

---

## Setup Steps

### Step 1: Confirm Platform

Need all three: `darwin` + `arm64` + realistic Apple Silicon local TTS setup. If not Apple Silicon, leave this lane.

### Step 2: Check for Existing MLX Runtime

1. Batshit-managed under `~/.batshit/tools/mlx-audio/`
2. User-managed on PATH
3. User-managed `uv tool` installs

If Batshit-managed exists and passes the fast health gate, move straight to the engine helper flow.

### Step 3: Install Shared Runtime If Needed

Create the shared venv, install `mlx-audio`, verify the server command.

The shared MLX runtime is only the Python/executable layer. Hugging Face model caches still stay per engine by default: set `HF_HOME` to `~/.batshit/installs/<engine-id>/hf-home` before model download or server launch. Reuse a shared Hugging Face cache only when the user explicitly asks for it, and record that path in the helper launch env with `BATSHIT_ALLOW_SHARED_HF_CACHE = "true"`.

### Step 4: Keep the Engine Root Separate

Even though the runtime is shared, create `~/.batshit/installs/<engine-id>/` for:
- Helper state
- Runtime logs
- Engine-specific files
- Hugging Face cache state (`hf-home/`) unless the user explicitly approved a shared cache
- Anything a rerun reset should later remove

**Important:** Keep the engine ID aligned to what the user asked for. Don't invent `chatterbox-turbo-mlx` — MLX is the runtime flavor, not a new engine name.

---

## Runtime Contract

`mlx_audio.server` exposes an OpenAI-compatible API:

- `requestFormat: "openai-compatible"`
- TTS: `/v1/audio/speech`
- STT: `/v1/audio/transcriptions` (when relevant)
- Health: `/v1/models`
- Server expects `model` in requests → set `ttsDefaults.modelId`
- Set `ttsDefaults.voiceId` only when genuinely valid for this engine

### Feature Truth Rule

Don't over-claim just because the underlying model can do more at CLI level.

- Model card shows inline expressive tags? → `inline_tokens` is fair
- Model supports voice cloning and Batshit can replay a managed reference-audio profile through `ref_audio`? → `supports.clone = true`
- Model needs extra clone transport Batshit still cannot send? → `supports.clone = false`
- Vendor-specific fields Batshit doesn't send? → Don't claim them
- For clone-capable MLX lanes, prefer PCM WAV reference clips for helper smoke and examples. Batshit can normalize local non-WAV `ref_audio` paths to PCM WAV via `ffmpeg` when available, but WAV should still be the first-choice sample format.

**Truthful Batshit capability beats theoretical model capability.**

---

## Preferred Registration Shape

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
      "expression": { "strategy": "inline_tokens" },
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

If the confirm gate appears, retry with `allowRisky: true`. Don't fall back to manual work.

---

## Model-Specific Notes

### Chatterbox Turbo
- Prefer this MLX lane over third-party wrappers on Apple Silicon
- Keep engine ID/root canonical as `chatterbox-turbo`
- Inline expressive tags valid if model card proves them
- Publish only the bundled default voice label (`alloy`) through `ttsDefaults.voiceId` and `voiceSurface.voices`; do not list generic OpenAI speaker names because Chatterbox Turbo MLX uses bundled conditionals or `ref_audio` instead of named speaker presets.
- Clone support is now truthful on the Batshit-managed MLX lane because Batshit can keep a local reference-audio profile and send it through `ref_audio`
- If the install root already includes both `.wav` and `.aiff` samples, choose the `.wav` sample for helper smoke/reference use

### Qwen3-TTS
- Strong first option on Apple Silicon if listed in `mlx-audio` docs
- Verify which Qwen3 flavor you're registering
- For `CustomVoice`, save a real supported speaker name in `ttsDefaults.voiceId` (for example `Ryan` or `Serena`) or helper/runtime smoke will fall back to the generic OpenAI voice placeholder and fail even while the server itself is healthy
- `CustomVoice` itself should still keep `supports.clone = false`: the server accepts `ref_audio` / `ref_text`, but the `CustomVoice` model branch routes to predefined-speaker generation and does not use the true ICL clone path
- If Batshit wants one visible Qwen provider, register a truthful suite:
  - visible `CustomVoice` lane for preset speakers + instruction control
  - hidden `Base` lane for real cloning
  - hidden `VoiceDesign` lane for text-described voice creation
- Don't claim one visible Qwen suite unless Batshit can pass the required fields and route each feature to the correct internal lane

---

## When to Leave This Lane

Switch away when:
- Machine is not Apple Silicon
- Model has no verified `mlx-audio` path
- User explicitly prefers native
- MLX runtime fails after one real smoke attempt

Fallback: usually `local-self-hosted-engines`, sometimes `openai-compatible-adapter`.

---

## Completion

This lane is complete when you can truthfully say:

> *"You're using a shared Batshit-managed MLX runtime on Apple Silicon. The runtime is running, the engine is registered in Engine Manager, and a real TTS smoke request passed."*

If that's not true, keep working or stop with a blocker report.
