# Kyutai Local TTS Playbook

Status: research-locked on 2026-05-17; not yet Batshit live-verified.

Use this playbook when the user asks for Kyutai Pocket TTS, Kyutai TTS 1.6B, Unmute-style local TTS, or a Mac/CPU-friendly local realtime TTS recommendation.

## Current Source Truth

- Kyutai TTS overview: `https://kyutai.org/tts`
- Pocket TTS repo: `https://github.com/kyutai-labs/pocket-tts`
- Pocket TTS model card: `https://huggingface.co/kyutai/pocket-tts`
- Delayed Streams Modeling repo for Kyutai TTS 1.6B: `https://github.com/kyutai-labs/delayed-streams-modeling`
- Kyutai TTS 1.6B model: `kyutai/tts-1.6b-en_fr`

Kyutai has two different local TTS shapes that matter to Batshit:

- **Pocket TTS**: small, CPU-friendly, voice-cloning capable, simple Python/CLI/server surface.
- **Kyutai TTS 1.6B**: larger true streaming model with PyTorch, Rust server, and MLX paths.

Do not collapse these into one engine. They have different hardware fit, quality, complexity, and adapter shape.

## Recommendation by Machine

- Apple Silicon / normal laptop: start with Pocket TTS as the practical local recommendation. It is small, CPU-friendly, and official docs report low first-audio latency on MacBook Air M4-class hardware.
- Apple Silicon / advanced streaming proof: evaluate Kyutai TTS 1.6B MLX only after Pocket TTS or direct Fish cloud has covered the user-facing need.
- NVIDIA server/4090: Kyutai TTS 1.6B Rust server is a credible streaming-server candidate, but Fish S2 should still be compared when quality/voice control is the priority.
- CPU-only non-Mac: Pocket TTS is the realistic candidate. Kyutai TTS 1.6B is not the first recommendation unless the user accepts complexity/performance risk.

## Pocket TTS Runtime Shape

Official quick paths:

```bash
uvx pocket-tts generate
pocket-tts generate
pip install pocket-tts
```

Pocket TTS also has a `serve` command in the official CLI docs, Python API support, exportable voice states, and community OpenAI-compatible streaming servers. The official repo says it runs on CPU, has audio streaming, supports voice cloning, and can generate faster than real time on small Mac hardware.

Batshit should prefer the official CLI/Python/server surface first. Use a community OpenAI-compatible server only after checking that it is maintained and after making the "community wrapper" risk clear.

## Kyutai TTS 1.6B Runtime Shape

Official repo path: `kyutai-labs/delayed-streams-modeling`.

The repo documents three implementation lanes:

- PyTorch for research/tinkering.
- Rust server for production-style streaming over WebSockets.
- MLX for Apple Silicon / iPhone / Mac.

Documented examples include:

```bash
echo "Hey, how are you?" | python scripts/tts_pytorch_streaming.py audio_output.wav
moshi-server worker --config configs/config-tts.toml
echo "Hey, how are you?" | python scripts/tts_rust_server.py - -
echo "Hey, how are you?" | python scripts/tts_mlx.py - - --quantize 8
```

The Rust server uses WebSockets and is the likely Batshit adapter target if this becomes a launch-supported true streaming local engine. The MLX script can stream output and supports quantization flags when the model is not fast enough for realtime.

## Credential / License Notes

Pocket TTS model files require accepting Hugging Face model conditions. Treat this as credential-gated setup:

- Ask before using any saved `huggingface` token.
- Keep secrets server-side through `launch.envFromApiKeys.HF_TOKEN = "huggingface"`.
- Do not paste tokens into commands or docs.

## Batshit Adapter Posture

Pocket TTS:

- Best first Mac/local playbook candidate.
- Register as managed local TTS only after Batshit proves the exact server/API surface.
- Do not promise native Batshit realtime until the server emits audio incrementally into an adapter Batshit owns.

Kyutai TTS 1.6B:

- Best Kyutai true-streaming research target.
- Likely needs a WebSocket adapter, not the existing OpenAI-compatible batch adapter.
- Strong LiveKit/direct comparison candidate later because it is designed for text arriving over time.

## Initial Registration Truth

Before live Batshit proof:

- `supportsTts: true`
- `supportsStt: false` for Pocket TTS; STT belongs to SA-071 / separate Kyutai STT setup
- `supportsClone: true` only when voice-state export/reference behavior is verified in the chosen lane
- `supports.streaming: false` until a Batshit-owned adapter receives incremental audio from that exact runtime
- `expression.strategy: "none"` unless the selected Kyutai lane documents and proves controllable inline style/prosody tags

## Hard Rules

- Do not bundle Kyutai model weights in Batshit.
- Do not use Hugging Face Spaces as an integration target.
- Do not present a community wrapper as official Kyutai support.
- Do not mark Kyutai launch-supported until health, TTS smoke, voice loading/cloning surface, cancellation, and streaming-vs-batch behavior are proven.
