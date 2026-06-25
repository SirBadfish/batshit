# Local / Self-Hosted Engines

Use this when the engine runs on the user's machine, in Docker, or on their own network server. This is the most involved path — it has real hardware requirements, install decisions, and runtime management.

---

## What This Covers

Any speech engine that runs locally or on user-controlled infrastructure: Piper, Kokoro, Coqui, WhisperCPP, faster-whisper, or any TTS/STT server the user stands up. The key difference from hosted engines is that something needs to be installed, configured, and running before Batshit can connect.

---

## Step-by-Step: Bare Machine to Working Engine

### Step 1: Confirm Preflight Is Done

You should already have the preflight results. If not, go back and run it. You need:
- OS, CPU arch, GPU class, RAM
- Docker availability
- Whether the engine is already installed
- Install ownership decision

### Step 2: Assess Hardware Realism

Be honest about whether this engine can run on this machine.

**Good:**
> *"Piper is a great fit — lightweight C++ engine, runs well on CPU. On your M2 Mac it'll be fast."*

**Also good (honest about limits):**
> *"Bark needs an NVIDIA GPU with 8+ GB VRAM. Your Mac has Apple Silicon, which Bark doesn't support yet. I'd recommend Kokoro instead, or a hosted API. What sounds better?"*

**Bad:**
> *"Let's try installing it and see what happens."*

Don't "try and see" with hardware-intensive engines. If the machine isn't suitable, say so before wasting time.

### NVIDIA / CUDA Prerequisite

For CUDA-heavy engines, treat CUDA readiness as a prerequisite — not part of this skill.

- Detect with `nvidia-smi` first
- If working, continue with the normal install flow
- If missing, stop plainly:

> *"This engine needs a working NVIDIA/CUDA setup. I can help with the speech engine after CUDA is in place, but driver installation needs to happen outside this skill first."*

Do not install or update NVIDIA drivers from this skill.

### Step 3: Compare Realistic Approaches

Before talking install commands, compare the credible local approaches for this machine.

Common comparisons:
- Shared MLX vs native per-engine runtime (Apple Silicon)
- Docker vs native
- Official package + wrapper vs third-party wrapper
- Connect existing vs fresh install

**Multiple credible paths?** Recommend the best one, mention the fallback, explain why, and get quick feedback.

**One clear path?** Say that plainly and keep moving.

Don't ask a vague "what do you want to do?" without a recommendation.

### Step 4: Decide Install Ownership

Make this explicit before running any commands.

**Option A — Batshit-managed:**
> *"I'll install Kokoro for you. Everything goes under `~/.batshit/installs/kokoro/` — organized and separate from the rest of your system."*

**Option B — User-guided:**
> *"I'll walk you through the install step by step. You'll run the commands — I'll tell you exactly what to type."*

**Option C — Connect existing:**
> *"Kokoro is already running, so I'll skip the install and just connect Batshit to it."*

If the user says "take the lead" — choose Option A.

### Step 5: Plan the Install

Tell the user what's going to happen:

> *"Here's the plan:*
> 1. *Clone the repo to `~/.batshit/installs/kokoro/`*
> 2. *Create a Python virtual environment*
> 3. *Install dependencies*
> 4. *Download the voice model (~500 MB)*
> 5. *Start the server and verify it works*
>
> *This will take a few minutes. Ready?"*

### Saved Credential Rule

Some installs need a third-party token for model weights (usually Hugging Face).

- Check saved credential availability through the current lane. In-app agents may receive saved-key availability context; portable agents must ask the user whether a Hugging Face key is already saved in Batshit or guide them to save one before registration.
- If `huggingface` is saved, ask permission to use it
- If already approved in the same message, don't re-ask
- Keep secrets server-side: use `launch.envFromApiKeys.HF_TOKEN = 'huggingface'`
- If the runtime needs gated weights at launch, include that mapping in the **first** helper payload — don't launch without it and wait for an auth error
- If no token exists, guide the user to create a free HF read token

### Python Isolation Rule

For Python-based engines, Batshit treats the runtime as engine-local, not machine-global.

**Default contract:**
- Install root: `~/.batshit/installs/<engine-id>/`
- Isolated environment: `~/.batshit/installs/<engine-id>/.venv`
- All package installs go through that isolated environment
- Launch scripts call the engine-local interpreter explicitly

**Do this:**
```bash
python3 -m venv ~/.batshit/installs/<engine-id>/.venv
~/.batshit/installs/<engine-id>/.venv/bin/pip install -r requirements.txt
```

**Don't do this:**
- `pip install ...` into system Python
- Change the machine's default Python
- Clone into `~` or Desktop after choosing a managed install root

Before installing dependencies, check repo metadata (`pyproject.toml`, `requirements.txt`) and honor Python version constraints.

**`uv` ownership rule:** Don't assume Batshit owns a `~/.batshit/tools/uv/` copy. If you use a global `uv`, say so. If `uv` reports a platform mismatch on Apple Silicon, switch to `python3 -m venv`.

### Apple Silicon Shared MLX Exception

There's one exception to the "one Python runtime per engine" rule: **Apple Silicon + verified `mlx-audio` path + local TTS.**

In that case, `mlx-audio` is a **shared isolated runtime** — installed once under `~/.batshit/tools/mlx-audio/`, reused for multiple engines. Each engine still keeps its own root under `~/.batshit/installs/<engine-id>/` for helper state, logs, and engine-specific files.

### Step 6: Execute the Install

For Batshit-managed installs:
- Use `~/.batshit/installs/<engine-id>/` as the root
- Clone repos there
- Create isolated Python environments inside that folder
- Keep everything self-contained
- For Hugging Face downloads, set `HF_HOME` inside the install root (for example `~/.batshit/installs/<engine-id>/hf-home`) before any model download or server launch, and include that same value in `launch.env.HF_HOME` when calling the helper. Do not let Batshit-managed engines silently fill the user's global `~/.cache/huggingface` cache.
- If the user explicitly chooses an existing shared cache, include the exact shared path in `launch.env.HF_HOME` or `launch.env.HF_HUB_CACHE`, set `launch.env.BATSHIT_ALLOW_SHARED_HF_CACHE = "true"`, and name that path in the handoff.
- Never edit Batshit's own system skill files during the install

**Key principles:**
- Prefer the simplest working path
- Don't force Docker if the user doesn't want it
- Don't force native if Docker is simpler and available
- Tell the user what's happening as you go
- Once you choose the managed install root, stay there

### Step 7: Start the Service

**For Batshit-managed local TTS installs, check the helper fit first.**

If you have a verified install root, a real launch command, and a truthful engine payload — your next action is `sys.voice.engine.complete_local_setup`, not manual shell launch.

For this helper-owned lane:
- Do **not** run `nohup ... &` or redirect to `server.log` yourself
- Do **not** invent `.env`, `start.sh`, or `launch.sh` files to bridge into the helper
- Do **not** manually register/enable after the helper fits
- If the repo already documents a server entrypoint, pass that directly to the helper
- If the helper raises a confirm gate and the user already approved the managed setup work, immediately retry `sys.voice.engine.complete_local_setup` with `allowRisky: true` using the same payload instead of falling back to manual launch/register work

**Manual launch is only for:**
- Non-TTS lanes where the helper doesn't fit
- Existing runtimes you're only verifying
- A concrete blocker where the helper truly can't be used

### Wrapper-Created Servers

Some good speech engines ship only a CLI or Python API, not a server. You may create a small wrapper when that is the cleanest path, but keep it inside `~/.batshit/installs/<engine-id>/` and make the request contract explicit:

- expose a real health endpoint
- expose the exact TTS/STT endpoint Batshit will call
- return raw audio bytes for OpenAI-compatible TTS
- accept `ref_audio` and `ref_text` if you register clone support
- keep model files, Hugging Face caches, profile caches, logs, and helper code inside the install root
- verify the wrapper with a direct smoke request before registration

If the runtime is GPU/Metal/thread-sensitive, keep all model load and inference work on one dedicated worker thread or process. A web framework may run request handlers in different threads; do not share model objects across threads unless the engine explicitly supports it.

If launching manually, use the repo's documented server entrypoint:
- `main.py`, `uvicorn app.main:app`, or whatever the docs say
- Don't invent a custom launcher when the repo already has one

Start the service, confirm it's running, then move to verification.

**Important for chat-driven setup:** Start long-running servers in a way that gives control back (detached, Docker, or PID-capturing pattern). Don't leave a foreground process blocking the shell.

On macOS, avoid GNU helpers like `timeout`. Use polling loops or the tool's own timeout setting.

### Step 8: Verify Health and Smoke

1. **Health check** — confirm the service is reachable and responding
2. **Smoke test** — send a real TTS/STT request and get valid output

> *"Health check passed — Kokoro responding on port 8880. Running TTS smoke test... Got audio output! Engine is working."*

**First-run nuance:** Some engines download weights on first startup. Health may report `initializing` — that's progress, not failure. Keep polling until ready or until a real error appears. Don't abandon the run because the engine is warming up.

### Step 9: Register and Enable

Once verified, register through Fabric. See `registration-patterns` for exact payloads.

If you used `sys.voice.engine.complete_local_setup`, this is already handled — just report the result.

### Step 10: Leave the User with Management Info

For Batshit-managed installs, tell the user:
- Where the engine was installed
- How to start/stop it
- That it needs to be running for Batshit to use it

> *"I set up Kokoro at `~/.batshit/installs/kokoro/`. The engine needs to be running whenever you want TTS in Batshit."*

---

## Install Path Decision Tree

```
Docker available and user OK with Docker?
├── Yes → Usually cleanest
│   └── Official Docker image exists?
│       ├── Yes → Use it
│       └── No → Community image or simple Dockerfile? Use it. Otherwise → native.
└── No → Native install
    └── Python engine?
        ├── Yes → venv in ~/.batshit/installs/<id>/
        └── No → Binary or other runtime in same folder
```

---

## Common Engine Patterns

### Lightweight CPU (Piper, espeak)
- Run well on any platform, pre-built binaries, no GPU needed, fast startup
- Expression: typically `none`

### Python-Based (Kokoro, Coqui)
- Need Python 3.8+ and a virtual environment
- May need model downloads (hundreds of MB to GBs)
- Some support Apple Silicon Metal, some need NVIDIA CUDA
- Expression: varies — check docs

### Docker-Based
- Cleanest isolation, need Docker running
- Check image architecture (some x86-only)
- macOS Docker can't pass through Apple Silicon GPU

### Whisper-Family STT
- Excellent on Apple Silicon via Metal, good on NVIDIA via CUDA
- CPU works but slower for larger models
- Model size matters: tiny/base fast, large/turbo need more hardware

---

## Stop Conditions

Stop and report if:
- Engine clearly can't run on this hardware
- Install commands fail twice with the same error
- Service starts but never becomes reachable
- Request contract doesn't match what Batshit sends
- Model downloads fail repeatedly

**Be specific:**
> *"The install failed because this engine requires CUDA and your Mac doesn't have an NVIDIA GPU. Kokoro runs great on Apple Silicon — want me to set that up instead?"*

---

## Completion

When everything works, deliver the completion report from the main SKILL.md. For local engines, include:
- Where the engine was installed
- How to start/stop it
- That it needs to be running for Batshit to use it
- Any hardware-specific notes
