# Nemotron ASR Streaming / MLX (Verified Engine Playbook)

Use this playbook when the user asks for **NVIDIA Nemotron ASR**, **Nemotron 3.5 ASR**, **Nemotron Speech Streaming**, or the **nemotron-asr-mlx** project on Apple Silicon. Load it first, then load the lane docs it points you to.

This is not a separate skill. It's a verified engine playbook inside `/voice-engine-installer`. A June 2026 install attempt got every major decision wrong; the hard rejects below come from that live failure.

---

## What This Playbook Owns

- The streaming-first rule: this model's whole point is live partial transcripts
- Lane choice: realtime WebSocket lane + recorded batch lane, registered together
- Hard rejects from the June 2026 failed install
- Word-boost truth
- The completion bar for this engine

**If this playbook conflicts with a generic lane doc, this playbook wins for Nemotron ASR.**

---

## What This Engine Is

- NVIDIA Nemotron Speech Streaming ASR (`nvidia/nemotron-speech-streaming-en-0.6b`), a **cache-aware streaming** conformer built for low-latency live transcription: each audio frame is processed once with state carried in ring buffers, so it emits accurate partial text *while the user speaks*.
- Apple Silicon lane: the MLX port — pip package `nemotron-asr-mlx` (upstream: `199-biotechnologies/nemotron-asr-mlx` on GitHub), model weights auto-download from HuggingFace `dboris/nemotron-asr-mlx` (~1.2 GB) on first load.
- Apple Silicon only for the MLX lane. On PC/Nvidia machines, route through `local-stt-readiness.md` lanes instead (Riva/NIM territory).

**Verify the installed package's current API before writing the adapter.** As of June 2026 the package exposed batch `model.transcribe(path)` plus a streaming session API (`model.create_stream(chunk_ms=...)`, `session.push(audio_chunk)` yielding events with `text_delta`, `session.flush()`). Confirm names and available chunk sizes against the version you installed; do not code from memory.

---

## The Streaming-First Rule

The user experience this engine exists for: **words appear live as the user speaks, from this engine, not from browser recognition or a recorded-turn activity placeholder.** That means registration is not complete until BOTH lanes work:

1. **Realtime lane (the point of this engine):** a local WebSocket adapter implementing Batshit's BYO `realtimeStt` contract — linear16 PCM at 16 kHz mono in, partial/final transcript events out, honest VAD/endpointing declarations, clean close handling. This engine genuinely produces token-level partials, so declare `partialResults: true` only after the WebSocket smoke shows real mid-utterance partial events. Streaming chunk size (latency vs accuracy) is a real setting on this lane; expose it in the engine `uiSchema`.
2. **Recorded lane (`sttPath`):** an HTTP endpoint that transcribes a finished uploaded file using **full-context batch decode** (`model.transcribe` or equivalent). Never re-chunk an uploaded file through the streaming session to "simulate" realtime — the audio is already complete, chunked decode only loses accuracy.

The existing `whisper-cpp-realtime` install (when present at `~/.batshit/installs/whisper-cpp-realtime/realtime-adapter.mjs`) is the protocol reference for the adapter shape: HTTP `/health` + recorded proxy + WebSocket `/stream`. Nemotron's adapter should improve on it by sending true partials instead of final-only turns. Load `registration-patterns` for the exact `realtimeStt` record fields.

---

## Word-Boost Truth

Word boosting (biasing decoding toward user vocabulary like "n8n" or "Batshit") is an official Nemotron 3.5 ASR feature in NVIDIA's runtimes. For the MLX lane:

- Use it **only if the installed `nemotron-asr-mlx` version exposes a real word-boost API**. Check the package's documentation/source for the parameter and wire it through `stt.providerOptions` (provider options now reach BYO engines as request fields).
- If the installed version has no native boost API, register the engine **without** word boost and tell the user it's pending upstream support. Do not improvise.

---

## Hard Rejects (June 2026 live failure)

- **Batch-only wrapper** — registering only an HTTP `/transcribe` endpoint and skipping the realtime lane discards the model's entire purpose. Batshit will treat that as recorded STT: activity feedback while the user speaks, then final text after stop, with no live words from this engine.
- **Streaming-decode on uploaded files** — running the recorded lane through `create_stream` chunking (e.g. 160 ms) garbled transcripts badly ("Nemotron" → "new immatron"). Recorded lane = full-context batch decode, always.
- **Monkey-patching package internals for word boost** — a hand-rolled `greedy_decode` patch that added +15 logit bias to every vocab token substring-matched against boost words corrupts decoding catastrophically. Never patch the package's decoder. Real boost API or no boost.
- **Silent filler fallbacks** — returning `"hello"` (or any fake text) when transcription is empty buries failures. Empty result → explicit error or honest empty response.
- **Launch-config drift** — the engine record's `localRuntime.launch` must start the exact server file you tested, using the install's own `.venv` python, with `logPath` under the install root. Registering a launch command that points at a different runtime (e.g. a generic `mlx_audio.server`) means the next reboot silently runs the wrong server.
- **Global pip installs** — engine root `~/.batshit/installs/nemotron-asr/` with its own `.venv`. That directory is mounted into sandboxed bash, so this install does not need Dangerous mode.

---

## Completion Bar

Per the Local STT Completion Rule, plus engine-specific proof:

1. Health endpoint responds from the engine record's `baseUrl`.
2. Recorded-lane smoke: one real uploaded recording transcribed via batch decode with sane output.
3. WebSocket realtime smoke: live microphone-format PCM streamed in, **partial events observed mid-utterance**, final transcript on endpoint/close, clean `CloseStream` handling.
4. Engine record registered with both lanes, honest `realtimeStt` declarations, chunk-size `uiSchema` on the realtime lane, and `localRuntime.launch` that reproduces the tested server exactly.
5. Voice settings pointed at the engine for both `stt` and `realtimeStt` only after the user confirms.
