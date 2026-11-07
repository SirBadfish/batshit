# Local STT Readiness

Use this reference when a user asks for local speech-to-text, private transcription, realtime microphone input, or an on-device alternative to cloud STT.

## Current Product Truth

- Batshit does not bundle local STT model weights by default.
- A local STT engine is not ready until the runtime is reachable and one real transcription smoke has passed.
- Recorded/uploaded-audio STT and realtime microphone STT are separate capabilities.
- Realtime microphone STT also needs turn detection, cancellation, and interruption behavior before it can replace browser Voice Mode.
- Keep the engine record disabled until the smoke proof is complete.
- For Batshit-managed installs, `sys.voice.engine.complete_local_setup` can own launch, readiness polling, transcription smoke, disabled registration, post-registration health, and final enablement when you provide `smoke.mode = "stt"` plus real `smoke.audioBase64`.

## Recommendation Lanes

| Machine / need | First look | Why |
|---|---|---|
| Mac / Apple Silicon | `whisper.cpp` or WhisperKit | Mature local Whisper paths with Apple-focused acceleration options. |
| Mac / Apple Silicon, streaming-first | Nemotron ASR MLX | Cache-aware streaming conformer with true live partial transcripts on-device. Load the `nemotron-asr-mlx` engine playbook — it owns lane choice and hard rejects. |
| PC / Nvidia | WhisperLive or faster-whisper | Practical server-shaped path with GPU-friendly backends; hardware proof is intentionally deferred to dedicated PC/NVIDIA testing. |
| Cross-platform streaming | sherpa-onnx | Official docs include streaming and non-streaming WebSocket servers/clients, microphone client examples, endpointing controls, and Silero/TEN VAD support. |
| Advanced Nvidia shop | NVIDIA Riva / NIM | Powerful GPU-accelerated ASR with streaming and VAD/end-of-utterance features, but heavy enough to stay advanced-only rather than the default local setup. |

## Setup Rules

1. Run normal runtime preflight first.
2. Pick one lane based on the machine, not model popularity alone.
3. Install under `~/.batshit/installs/<engine-id>/` for Batshit-managed installs unless the user is connecting an existing runtime.
4. Verify health.
5. Run one real audio transcription smoke. Prefer `sys.voice.engine.complete_local_setup` for Batshit-managed installs.
6. Register disabled through Engine Manager.
7. Enable only after proof.

## Local STT Model Management

Do **not** install every Whisper model during first setup. Install one starter model, prove the engine, then publish a model catalog so the user can download upgrades from Engine Manager later.

For `whisper.cpp`, the practical starter is `tiny.en` when you need a quick proof, or `base.en` when the user wants a better default and the download time is acceptable. Publish larger models such as `small.en`, `medium.en`, and `large-v3` as downloadable choices. There is no upstream `large.en` whisper.cpp model; use `large-v3` with `sttDefaults.language = "en"` / `--language en` when the desired behavior is English-only transcription on the full large model.

Engine payloads can include:

- `sttDefaults.modelId` — the model value Batshit sends to the STT endpoint.
- `sttModelCatalog.kind = "whisper.cpp"` — enables local model management semantics.
- `sttModelCatalog.modelDir = "models"` — model files live under the engine install root.
- `sttModelCatalog.activeModelId` — the currently selected catalog model.
- `sttModelCatalog.requiresRestartOnModelChange = true` for runtimes like `whisper.cpp` that load model weights at process start.
- `sttModelCatalog.models[]` entries with `id`, `label`, `filename`, `requestModel`, `url`, `sizeBytes`, and `installed`.

When the user wants a larger model:

1. Use `sys.voice.engine.model.download` or the Engine Manager download button.
2. Keep the current model active while the new file downloads.
3. Use `sys.voice.engine.model.use` only after the file is installed.
4. If the catalog says restart is required, say that plainly and restart/health-check the runtime before claiming the new model is actually serving transcription.

## Realtime Warning

Do not label a local STT engine as realtime just because it can transcribe short recordings quickly. Realtime support means Batshit has a live microphone transport, partial/final events, endpointing or VAD behavior, cancellation, and clear error handling.
