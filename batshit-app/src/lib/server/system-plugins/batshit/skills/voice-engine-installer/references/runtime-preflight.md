# Runtime Preflight

Run this before any install, connection, or engine registration. The preflight tells you whether the setup is realistic and which path to take.

---

## How to Run It

This is a **conversation**, not a silent checklist. Gather what you can automatically, ask one or two targeted questions for the rest, and present the full picture before moving on.

### What to Gather

| Fact | How | Why |
|---|---|---|
| **OS** | `uname -s` | Many engines are platform-specific |
| **CPU arch** | `uname -m` | ARM vs x86 changes install paths |
| **GPU class** | Auto-detect or ask | GPU-only engines won't work on CPU-only machines |
| **NVIDIA/CUDA** (NVIDIA PC only) | `nvidia-smi` | Frontier local engines may need a working NVIDIA stack |
| **RAM** | Auto-detect | Some engines need significant memory |
| **Docker** | `docker info` | Many local engines are easiest via Docker |
| **MLX runtime** (Apple Silicon only) | Check `~/.batshit/tools/mlx-audio/` | Helps decide shared MLX vs native path |
| **Engine already installed?** | Ask or check common paths | Skip install if already running |
| **Hosted provider or local/self-hosted?** | Usually clear from the user's request | Determines whether this stays on the BYO setup path or routes to the built-in provider path |
| **TTS, STT, or both?** | Ask if unclear | Some engines only do one |
| **Install ownership** | Ask for local engines | Batshit installs it vs user installs with guidance vs connect existing |
| **User priority** | Ask when there is a real tradeoff | Helps choose between simplest install, fastest local path, strict official path, or highest quality |

### How to Gather (Not Like an Interrogation)

**Do this:** Run automatic checks first, then summarize and ask about the rest in one natural message.

> *"Let me check your setup real quick.*
>
> *OK — macOS 14.3, Apple Silicon (M2 Pro), 32 GB RAM. Docker Desktop is installed and running. Looks like a strong machine for local TTS.*
>
> *Do you want me to install the engine for you and handle the whole setup, or would you rather do it yourself with me guiding you?"*

**Don't do this:**

> *"What OS are you running?"*
> *(waits)*
> *"What CPU do you have?"*
> *(waits)*

### Automatic Detection Commands

```bash
# OS and architecture
uname -s        # Darwin, Linux
uname -m        # arm64, x86_64

# macOS specific
sw_vers 2>/dev/null
sysctl -n machdep.cpu.brand_string 2>/dev/null
sysctl -n hw.memsize 2>/dev/null

# Linux specific
cat /etc/os-release 2>/dev/null
free -h 2>/dev/null

# GPU: Apple Silicon = arm64 + Darwin; NVIDIA = nvidia-smi
nvidia-smi 2>/dev/null

# Docker
docker info >/dev/null 2>&1 && echo "Docker: available" || echo "Docker: not available"

# Python
python3 --version 2>/dev/null || python --version 2>/dev/null

# Batshit-managed MLX runtime (Apple Silicon local TTS only)
test -x ~/.batshit/tools/mlx-audio/.venv/bin/python && echo "batshit-shared-mlx: present" || echo "batshit-shared-mlx: missing"
```

Run the relevant ones silently, then summarize for the user.

---

## Preference Pulse (Only When It Matters)

If the next step involves a real choice between paths, capture what the user cares about most:

- Simplest install
- Fastest local performance
- Strict official/native runtime
- Highest quality even if fussier

Don't ask when there's only one realistic option. But when there are two credible paths, this one answer shapes your recommendation.

---

## Platform Quick Reference

| Platform | Strengths | Watch Out For |
|---|---|---|
| **macOS Apple Silicon** | Great for local TTS. Metal acceleration. Verified `mlx-audio` paths are often the best first option. | CUDA-only engines won't work. Some Docker images are x86-only. |
| **macOS Intel** | Can run most CPU-based engines. Docker works fine. | No Metal. No CUDA. Limited GPU inference. |
| **Linux + NVIDIA** | Best for GPU-heavy inference. Full CUDA. Docker + GPU passthrough. | Need correct NVIDIA drivers + CUDA toolkit. |
| **Windows + NVIDIA** | Strong for frontier local GPU TTS. | CUDA is a prerequisite, not something this skill installs. |
| **Linux CPU-only** | Good for lightweight engines and API setups. | GPU-heavy engines will be very slow. |
| **Windows** | Works for Docker-based setups. Some native Python engines work. | WSL2 may be needed. GPU passthrough can be tricky. |

### Quick Decision Aid

- **Built-in hosted provider request?** Platform barely matters. Focus on saved-key status, readiness, and provider selection in Settings.
- **Hosted provider request?** Platform barely matters. First decide whether Batshit already ships it as a built-in provider; if not, this is future built-in product work, not a BYO engine lane.
- **Lightweight local** (Piper, espeak)? Most platforms work. Check CPU arch.
- **GPU-heavy local** (Bark, large models)? Need NVIDIA on Linux, or Apple Silicon on Mac.
- **Apple Silicon local TTS?** Check for a verified `mlx-audio` lane first — it's usually the best Mac option.
- **CUDA-heavy engine on NVIDIA?** Confirm `nvidia-smi` works. If CUDA isn't there, stop and explain it's an external prerequisite.

---

## The Preflight Report

Present a compact summary before continuing:

> *"Here's what I found:*
>
> | | |
> |---|---|
> | *OS* | *macOS 14.3 (Sonoma)* |
> | *Architecture* | *arm64 (Apple Silicon M2 Pro)* |
> | *RAM* | *32 GB* |
> | *GPU* | *Apple Silicon (Metal)* |
> | *Docker* | *Installed and running* |
> | *Scope* | *TTS only* |
> | *Path* | *Local/self-hosted* |
> | *Install ownership* | *Batshit-managed* |
> | *Priority* | *Fastest local path* |
>
> *Everything looks good for local TTS. Next I'll compare the realistic approaches and recommend the best fit."*

If any fact is missing or unclear, say exactly what's missing before you continue.

---

## What Happens Next

Go back to the main SKILL.md workflow. The compare/recommend step comes next — preflight narrows the field, but doesn't pick the final path by itself.

### Apple Silicon MLX Note

Preflight only decides whether the MLX lane is *realistic* and whether a shared runtime already exists. Don't turn preflight into a deep runtime audit with repeated package listings or venv forensics. That work happens later if you pick the MLX path.
