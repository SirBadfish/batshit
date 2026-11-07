# Fish Speech S2 / Fish Audio S2 Local Playbook

Status: research-locked on 2026-05-17; not yet Batshit live-verified.

Use this playbook when the user asks for local/self-hosted Fish Speech S2, Fish Audio S2, or `fishaudio/s2-pro`.

## Current Source Truth

- Official repo: `https://github.com/fishaudio/fish-speech`
- Official docs: `https://speech.fish.audio/install/`
- Official server docs: `https://speech.fish.audio/server/`
- Model/report source: `https://huggingface.co/papers/2603.08823`
- Model weights: `fishaudio/s2-pro`

Fish S2 Pro is the highest-quality first-wave local Fish target, but it is heavy. Official inference docs recommend a GPU with at least `24GB` VRAM. Treat an NVIDIA 4090-class machine as the clean first target. Do not recommend this as the easy Apple Silicon default unless a separate MLX path is verified for this exact setup.

## Hardware Recommendation

- NVIDIA 4090 / 24GB VRAM: best first local target.
- Smaller NVIDIA GPU: discuss quality/performance risk before installing.
- Apple Silicon: research-only until a Batshit-verified MLX or wrapper route exists. Community MLX model cards may exist, but they are not enough by themselves for a launch-supported Batshit setup.
- CPU-only: do not recommend for S2 Pro.

## Runtime Shape

The official HTTP server entrypoint is:

```bash
python tools/api_server.py \
  --llama-checkpoint-path checkpoints/s2-pro \
  --decoder-checkpoint-path checkpoints/s2-pro/codec.pth \
  --listen 0.0.0.0:8080
```

Documented server checks/endpoints:

- `GET /v1/health`
- `POST /v1/tts`
- `POST /v1/vqgan/encode`
- `POST /v1/vqgan/decode`

The local server chooses the base model at startup from the checkpoint paths. Per-request model selection is not part of the documented local client path. Voice selection can use `reference_id` when a saved reference voice exists.

## Batshit Adapter Posture

- Treat hosted Fish Audio as Batshit's built-in `fish` provider.
- Treat local Fish Speech S2 as a managed local/self-hosted engine through Engine Manager.
- Do not register hosted Fish Audio as `byo:fish`.
- Do not claim local S2 streaming inside Batshit until the local server path has a proven streaming response shape. The official paper reports production streaming via the SGLang-based inference engine, but Batshit still needs a local adapter smoke before marking `supports.streaming = true` for any `byo:` Fish engine.
- If the local server only exposes full-response `/v1/tts` in the verified setup, register it as batch TTS first and keep realtime support pending.

## Install Ownership

For Batshit-managed installs:

- Install root: `~/.batshit/installs/fish-speech-s2/`
- Model/checkpoint root under that install root unless the user explicitly chooses another model cache.
- Use isolated Python or official Docker only. Do not install into system Python.
- If Hugging Face access or license acceptance is required, ask before using any saved `huggingface` token and keep it server-side through `launch.envFromApiKeys`.
- Do not install or update NVIDIA drivers/CUDA from this skill. `nvidia-smi` must already work.

## Recommended Flow

1. Run runtime preflight.
2. If NVIDIA 24GB+ is available, recommend official local server or official Docker profile.
3. If Apple Silicon, recommend Kyutai Pocket TTS first unless the user explicitly wants a Fish MLX research spike.
4. Download `fishaudio/s2-pro` into the managed install root.
5. Start the documented server.
6. Health check `GET /v1/health`.
7. Run a real `/v1/tts` smoke and save a small audio output.
8. Register disabled first through `sys.voice.engine.register`.
9. Enable only after health and TTS smoke pass.

## Registration Notes

Use a custom/BYO local engine record, not a hosted provider record.

Initial truth before Batshit live proof:

- `supportsTts: true`
- `supportsStt: false`
- `supportsClone: true` only if a reference-voice path is actually verified
- `supports.streaming: false` until local streaming is proven through the chosen server
- `expression.strategy: "instructions"` if emotion/prosody tags are preserved in the local request path

Do not mark the engine launch-supported until a Batshit smoke proves health, audio generation, reference voice behavior, cancellation behavior, and whether the response is batch or streaming.
