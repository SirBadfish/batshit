# dots.tts-soar MLX Playbook

Use this when the user asks for `rednote-hilab/dots.tts-soar`, dots.tts, or the fast-growing Hugging Face dots.tts voice-cloning model on Apple Silicon.

Status: live-proved on a Mac app target on 2026-06-16 with a Portable Skill Token, an M1 Max, `dots-tts-mlx` v0.7.0, `shraey/dots-tts-mlx` `int4/` weights, a local OpenAI-compatible wrapper, and Batshit provider `byo:dots-tts-soar`.

## Source Truth

- Upstream PyTorch model: `rednote-hilab/dots.tts-soar`.
- Apple Silicon runtime: `sb1992/dots-tts-mlx`.
- Ready MLX weights: `shraey/dots-tts-mlx`.
- License: Apache-2.0 for upstream model/code and the MLX port.

The upstream family has three user-relevant variants:

| Variant | Use |
|---|---|
| `dots.tts-base` | Pretrained base/fine-tuning start |
| `dots.tts-soar` | Best zero-shot fidelity and speaker similarity; default for quality/voice cloning |
| `dots.tts-mf` | MeanFlow distilled, lower latency, roughly 2x faster |

On Apple Silicon, prefer the MLX port over the upstream PyTorch runtime. The upstream runtime chooses CUDA when available and otherwise CPU; on a Mac that means the 2B model can run without Metal acceleration. The MLX port is purpose-built for Apple Silicon and has ready converted weights.

## Voice-Chat Suitability Warning

`dots.tts-soar` is a **quality-first cloning checkpoint**, not a comfortable default for realtime-ish Batshit voice chat on every Mac. Live Mac app testing on 2026-06-16 proved the SOAR int4 lane can install, register, clone, and synthesize, but on an M1 Max test machine it was far slower and more thermally heavy than Chatterbox Turbo MLX. Treat SOAR as a showcase/quality lane unless the user explicitly accepts slow generation and high resource use.

If the user asks for a normal responsive local voice-chat engine, recommend a faster proven lane first, such as Chatterbox Turbo MLX or Kokoro MLX. If the user specifically wants the dots.tts family but cares about speed, use the MeanFlow `mf-int4/` variant instead of SOAR and register it with an honest engine ID/name such as `dots-tts-mf`.

## Recommended Mac Lane

Use a Batshit-managed install:

- Engine ID: `dots-tts-soar`
- Install root: `~/.batshit/installs/dots-tts-soar`
- Python: 3.10+ in an engine-local `.venv`
- Runtime: `git+https://github.com/sb1992/dots-tts-mlx.git@v0.7.0`
- Weights: `hf download shraey/dots-tts-mlx --include "int4/*" --local-dir ~/.batshit/installs/dots-tts-soar/weights`
- Default model label for Batshit: `dots-tts-soar-int4-mlx`

Pick `int4/` only for the quality/default SOAR path. Pick `mf-int4/` when the user prioritizes lower latency or wants Batshit voice-chat practicality over the pure SOAR quality target. Do not install every variant up front unless the user asks.

## MeanFlow Variant / Swap Difficulty

MeanFlow is not a runtime flag on the current Batshit engine record. It is a different dots.tts checkpoint loaded from a different weights directory:

- SOAR quality path: `weights/int4/`, model label `dots-tts-soar-int4-mlx`, default steps `10`
- MeanFlow speed path: `weights/mf-int4/`, model label `dots-tts-mf-int4-mlx`, default steps `4`

The MLX runtime auto-detects MeanFlow from the loaded weights' `config.json`; no separate `--meanflow` flag is needed. Switching an already-running Dots server from SOAR to MeanFlow means downloading the `mf-int4/*` weights, changing the launch environment to point `DOTS_TTS_MODEL_DIR` at `weights/mf-int4`, updating `ttsDefaults.modelId`, and restarting the runtime.

Do **not** present this as a Whisper-style in-app model picker today. Batshit currently has polished download/use controls for local STT model catalogs; Dots TTS model switching is better handled as either:

- a separate engine such as `dots-tts-mf` on its own port, or
- a deliberate update to the existing `dots-tts-soar` local runtime plus a restart.

Prefer a separate `dots-tts-mf` engine when comparing SOAR vs MeanFlow, because users can switch Batshit TTS providers without losing the quality-first SOAR setup.

If using `sys.voice.engine.complete_local_setup`, Batshit-managed installs must use the install root that matches the engine ID. For MeanFlow, use `~/.batshit/installs/dots-tts-mf`, not the SOAR install root. If the user is installing MeanFlow as the only retained Dots engine, keep `.venv`, `server.py`, `weights/`, `default-reference/`, `profiles/`, `logs/`, and `outputs/` inside `~/.batshit/installs/dots-tts-mf`. A lightweight sibling root with symlinks to `dots-tts-soar` is only acceptable when SOAR is intentionally retained too and the handoff names the shared folder. Keep `launch.logPath` inside the verified install root, such as `~/.batshit/installs/dots-tts-mf/logs/runtime.log`.

## Voice Surface Truth

dots.tts is a voice-cloning engine, not a normal preset-voice catalog.

- It requires reference audio plus the exact transcript for best cloning.
- The MLX runtime does not support random/no-reference sampling.
- For plain agent TTS before the user creates a clone, provide a clearly labeled bootstrap default reference clip, or ask the user for an authorized default reference.
- Voice Studio clone profiles work when the wrapper accepts Batshit's `ref_audio` and `ref_text` fields.

Register the voice surface as `hybrid` only if you provide a bootstrap default voice and clone profiles. If there is no default reference voice, register it as clone-profile-focused and tell the user they need to create/select a Voice Studio clone before normal agent speech will work well.

Dots does not ship a catalog of named speaker presets. If you provide a bootstrap default reference, publish exactly that default voice through `ttsDefaults.voiceId: "default"` and `voiceSurface.voices: ["default"]`; do not invent additional voice dropdown entries.

## Wrapper Contract

The MLX runtime ships a CLI/Python API, not a Batshit-ready HTTP server. Create a small wrapper under the install root that exposes:

- `GET /health`
- `POST /v1/audio/speech`
- OpenAI-compatible JSON body with at least `model`, `input`, `voice`, and `response_format`
- Batshit clone fields `ref_audio` and `ref_text`
- raw `audio/wav` response bytes

Set `requestFormat: "openai-compatible"` and `supports.clone: true` only after a real request with `ref_audio` and `ref_text` returns audio.

Important MLX runtime rule: keep all model load, voice enrollment, and generation on one dedicated worker thread or process. A FastAPI sync route can run in a different worker thread and trigger MLX errors such as `There is no Stream(gpu, 1) in current thread`. The wrapper may use FastAPI, but route MLX work through one worker queue.

## Registration Shape

Use `sys.voice.engine.complete_local_setup` when the wrapper launch command is ready.

Minimum payload facts:

```json
{
  "engineId": "dots-tts-soar",
  "installRoot": "~/.batshit/installs/dots-tts-soar",
  "installOwnership": "batshit-managed",
  "launch": {
    "command": ".venv/bin/python",
    "args": ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8121"],
    "cwd": "."
  },
  "payload": {
    "name": "dots.tts-soar (MLX)",
    "baseUrl": "http://127.0.0.1:8121",
    "ttsPath": "/v1/audio/speech",
    "healthPath": "/health",
    "requestFormat": "openai-compatible",
    "supports": { "tts": true, "stt": false, "clone": true },
    "ttsDefaults": {
      "modelId": "dots-tts-soar-int4-mlx",
      "voiceId": "default",
      "common": {
        "speed": 1
      },
      "providerOptions": {
        "response_format": "wav",
        "ref_audio": "<default-or-user-authorized-reference.wav>",
        "ref_text": "<exact reference transcript>",
        "lang_code": "EN",
        "num_steps": 10,
        "guidance_scale": 1.2,
        "speaker_scale": 1.5,
        "seed": 42
      }
    },
    "uiSchema": {
      "sections": [
        {
          "id": "generation",
          "title": "Generation",
          "description": "Common Dots quality and speed controls.",
          "fields": [
            {
              "id": "num_steps",
              "type": "number",
              "label": "Steps",
              "path": "tts.providerOptions.num_steps",
              "defaultValue": 10,
              "min": 2,
              "max": 16,
              "step": 1,
              "help": "Controls solver steps. SOAR defaults to 10 for quality. MeanFlow defaults to 4 for speed; fewer steps are faster but may reduce quality."
            },
            {
              "id": "guidance_scale",
              "type": "number",
              "label": "Guidance Scale",
              "path": "tts.providerOptions.guidance_scale",
              "defaultValue": 1.2,
              "min": 0,
              "max": 3,
              "step": 0.1,
              "help": "SOAR classifier-free guidance strength. Keep the default unless tuning. MeanFlow ignores this because guidance is distilled into the checkpoint."
            },
            {
              "id": "speaker_scale",
              "type": "number",
              "label": "Speaker Scale",
              "path": "tts.providerOptions.speaker_scale",
              "defaultValue": 1.5,
              "min": 0.5,
              "max": 3,
              "step": 0.1,
              "help": "How strongly the reference voice influences the clone. Higher can match identity more strongly but may sound less natural."
            },
            {
              "id": "speed",
              "type": "number",
              "label": "Speed",
              "path": "tts.common.speed",
              "defaultValue": 1,
              "min": 0.75,
              "max": 1.5,
              "step": 0.05,
              "help": "Playback tempo applied after generation. 1 is normal speed; higher is faster."
            },
            {
              "id": "lang_code",
              "type": "string",
              "label": "Language Code",
              "path": "tts.providerOptions.lang_code",
              "defaultValue": "EN",
              "placeholder": "EN",
              "help": "Uppercase language code passed to Dots, such as EN, ES, FR, DE, or HI. Ask the user before switching this away from their normal language."
            }
          ]
        }
      ]
    },
    "voiceSurface": {
      "kind": "hybrid",
      "summary": "Dots uses a default reference voice plus Batshit clone profiles; it does not ship named preset speakers.",
      "voices": ["default"],
      "requiresDiscussion": false
    },
    "expression": { "strategy": "none" },
    "voiceDiscovery": { "mode": "none" },
    "readiness": { "mode": "health" }
  }
}
```

Use a free port. The live proof used `8121`; do not hard-code it if it is busy.

For MeanFlow, use the same shape with:

- engine ID `dots-tts-mf`
- name `dots.tts-mf (MLX)`
- install root `~/.batshit/installs/dots-tts-mf`
- weights path `weights/mf-int4`
- model ID `dots-tts-mf-int4-mlx`
- `num_steps` default `4`
- guidance help text that clearly says MeanFlow ignores `guidance_scale`

## Expression Strategy

Use `none`.

dots.tts can sound expressive from the text and reference voice, but this lane does not expose a separate safe Batshit expression control. Do not claim inline tokens or instruction support unless a future wrapper proves a real field and Batshit sends it intentionally.

## Completion Bar

Only call it ready when:

- health returns ready with `model_loaded: true`
- one TTS smoke returns real WAV bytes
- one clone-shaped request with `ref_audio` and `ref_text` returns real WAV bytes
- the engine is registered/enabled as `byo:dots-tts-soar`
- the user is told that Voice Studio clones need authorized reference audio and accurate transcript text
- the user is told that SOAR is quality-first/slow and that `mf-int4/` or a different engine is the better route for responsive voice chat

Report that STT is not supported.
