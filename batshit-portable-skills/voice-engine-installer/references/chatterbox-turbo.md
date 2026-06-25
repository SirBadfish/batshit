# Chatterbox Turbo (Verified Engine Playbook)

Use this playbook when the user explicitly asks for **Chatterbox Turbo**. Load it first, then load the lane docs it points you to.

This is not a separate skill. It's a verified engine playbook inside `/voice-engine-installer` that saves you from treating Chatterbox Turbo like a generic "local TTS" bucket.

---

## What This Playbook Owns

- Lane choice: Apple Silicon MLX vs official native
- Hard rejects for known bad wrappers
- Clone and reference-audio truth
- `uv` ownership rules
- The completion bar for this engine

**If this playbook conflicts with a generic lane doc, this playbook wins for Chatterbox Turbo.**

---

## Lane Choice

### Prefer MLX on Apple Silicon when:
- Machine is `macOS + arm64`
- The MLX route is verified for the requested model
- User wants the best practical local Mac path

**MLX lane defaults:**
- Shared runtime: `~/.batshit/tools/mlx-audio/`
- Engine root: `~/.batshit/installs/chatterbox-turbo/`
- Engine ID: `chatterbox-turbo`
- Default model: `mlx-community/chatterbox-turbo-fp16`
- Default voice label: `alloy` for the bundled Chatterbox conditionals

### Use the official native lane when:
- User explicitly wants upstream native/runtime
- MLX route is no longer clearly verified
- Machine is not Apple Silicon

**Native lane defaults:**
- Engine root: `~/.batshit/installs/chatterbox-turbo/`
- Engine ID: `chatterbox-turbo`
- Must use the Turbo-specific class, not the generic one

---

## Already Installed On This Machine

If the user says Chatterbox Turbo is already installed for another Batshit instance, treat that as a **reuse/connect-existing install-root case**, not as a reason to skip target-instance setup.

Remember that native/dev Batshit and the packaged Mac app can use different Redis/data roots. An engine can exist on disk and be registered in one Batshit instance while the target instance still reports `byo:chatterbox-turbo` as not configured.

Do this:

1. Confirm the target Batshit base URL first.
2. Run the normal portable token proof against that target instance.
3. Fast-gate the shared MLX runtime and `~/.batshit/installs/chatterbox-turbo/` install root.
4. Call `sys.voice.engine.health_check` for `chatterbox-turbo` on the target instance.
5. If health says not configured, use `sys.voice.engine.complete_local_setup` with the existing install root and shared MLX launch command. The helper should launch the runtime if needed, run Batshit's helper-owned smoke, register the target instance, and enable the engine.
6. Do not copy Redis records between instances. Do not reinstall the shared MLX runtime unless the fast gate proves it is missing or broken.

---

## Hard Rejects

- **`devnen/Chatterbox-TTS-Server`** — not the Batshit-managed lane. Live proof showed it bypasses the helper, falls back from CUDA to CPU on Mac, lacks `/health`, and fails Turbo load with a Perth watermarker error.
- **Bypassing `sys.voice.engine.complete_local_setup`** — when the helper fits, use it. Don't invent manual launch/register steps.
- **Inventing `chatterbox-turbo-mlx`** — MLX is the runtime flavor, not a new engine ID. Keep `chatterbox-turbo` unless the user explicitly wants side-by-side variants.
- **Rescuing the wrong wrapper** — if you find yourself doing `pkill`, `uvicorn.run(...)`, `resemble-perth` version experiments, or package surgery inside a third-party wrapper, you're fixing the wrong thing. Delete that install root and return to the official path.

---

## `uv` Ownership Rule

Don't assume Batshit owns a `~/.batshit/tools/uv/` copy.

- If you use a global `uv`, say that plainly
- If `uv` reports a platform mismatch on arm64 Apple Silicon, stop using `uv` and switch to `python3 -m venv`

Safest Batshit-managed MLX setup fallback:
```bash
mkdir -p ~/.batshit/tools/mlx-audio
python3 -m venv ~/.batshit/tools/mlx-audio/.venv
~/.batshit/tools/mlx-audio/.venv/bin/pip install -U pip
~/.batshit/tools/mlx-audio/.venv/bin/pip install -U mlx-audio
```

---

## Known Apple Silicon MLX Bootstrap Repair

The first Batshit-managed Chatterbox Turbo MLX install on Apple Silicon may hit a short shared-runtime dependency chain. This is a **known bootstrap repair**, not a blocker:

1. `mlx_audio.server` missing `webrtcvad`
2. Then `pkg_resources` missing because `setuptools` floated to `82+`
3. Then missing `fastapi` and/or `python-multipart`

**Handle this as one repair lane:**
- Keep all fixes inside `~/.batshit/tools/mlx-audio/.venv/`
- Pin `setuptools<81` when `pkg_resources` is the issue
- Verify `mlx_audio.server --help` once
- Then move straight into the engine-specific helper flow

If the user approved a managed install, don't stop after each dependency to ask. Only stop when the same step fails again without new information.

---

## MLX Lane Truth

- Request format: `openai-compatible`
- TTS path: `/v1/audio/speech`
- Health path: `/v1/models`
- `ttsDefaults.modelId`: required — usually `mlx-community/chatterbox-turbo-fp16`
- `ttsDefaults.voiceId`: set to `alloy` for the bundled default voice label. Do not expose the full OpenAI voice list; the MLX Chatterbox Turbo model does not publish `alloy` / `echo` / `nova` as separate voices.
- `voiceSurface`: publish `voices: ["alloy"]` with a summary that explains this is the bundled precomputed Chatterbox voice, while extra voices come from Batshit clone/reference-audio profiles.
- `supports.clone`: `true` on the Batshit-managed MLX lane because Batshit can now save local reference-audio voice profiles and replay them through `ref_audio` on normal BYO synth requests
- For clone proof/smoke, prefer a real PCM `.wav` reference clip when you have one. Batshit can normalize local non-WAV `ref_audio` paths to PCM WAV via `ffmpeg` when available, but don't choose AIFF/WebM first if a WAV sample is already there.
- Expression: `inline_tokens` is fair when the model docs prove paralinguistic tags
- Always include `launch.env.HF_HOME = "~/.batshit/installs/chatterbox-turbo/hf-home"` for Batshit-managed installs so Chatterbox Turbo weights and S3Tokenizer stay under the engine root
- If user approved a saved HF token: `launch.envFromApiKeys.HF_TOKEN = 'huggingface'`

The MLX server accepts a `voice` string for OpenAI-compatible shape, but Chatterbox Turbo voice identity actually comes from either its bundled `conds.safetensors` or a provided `ref_audio`. Treat `alloy` as Batshit's stable label for that bundled default, not as proof of a runtime-discovered voice catalog.

---

## Native Lane Truth

- Use `chatterbox.tts_turbo.ChatterboxTurboTTS` — not the generic `chatterbox.tts.ChatterboxTTS`
- First smoke path needs a real reference wav or prepared conditionals
- If Apple Silicon hits the Perth/watermarker issue, patch the install-root wrapper with a local dummy/no-op fallback — don't treat the whole engine as impossible
- Official weights come from Hugging Face — include `launch.env.HF_HOME = "~/.batshit/installs/chatterbox-turbo/hf-home"` and include `launch.envFromApiKeys.HF_TOKEN = 'huggingface'` in the first helper payload if the user approved the saved key

---

## Completion Bar

"Installed" means **all** of these:
- Runtime is reachable
- Helper-owned smoke succeeded
- Saved engine payload has a truthful `ttsDefaults.modelId`
- Saved engine payload has `ttsDefaults.voiceId: "alloy"` plus a `voiceSurface` that lists only `alloy`
- Engine is registered/enabled through the helper path
- Batshit can make a normal synth request without hidden extra context. For portable agents, the `sys.voice.engine.complete_local_setup` helper-owned smoke counts as this proof because it calls Batshit's BYO speech adapter with the same record contract Batshit runtime playback uses. Do not use session-only routes like `/api/voice/synthesize`, internal `BATSHIT_TOKEN`, or copied session cookies from a portable skill just to prove this. A signed-in UI preview is useful human QA, but it is not part of the portable HTTP contract.

If any are false, report the blocker plainly.

---

## What to Load After This Playbook

1. `mlx-audio-apple-silicon` — when the MLX lane is the best fit
2. Otherwise `local-self-hosted-engines`
3. Then `expression-contract`
4. Then `registration-patterns`
5. `failure-handling` — only if something breaks
