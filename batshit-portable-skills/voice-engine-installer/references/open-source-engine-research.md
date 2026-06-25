# Open-Source / Fast-Moving Engine Research

Use this when the engine is unfamiliar, new, poorly documented, or mainly known through GitHub repos, HuggingFace Spaces, or social media buzz. This path protects you from guessing — research first, then commit to one lane.

**This is a short research phase, not a stopping point.** If the engine is viable, you must immediately load the chosen lane reference and continue in the same turn. Don't hand back a research summary and wait.

---

## Step 1: Find the Primary Source

Before anything else, find the authoritative source:

- **GitHub repo** — usually best. Main README, API docs, recent commits/releases.
- **HuggingFace model card or Space** — good for capabilities, but Spaces are demos, not integration targets.
- **Official docs/website** — if dedicated docs exist, they're usually most reliable.

**Don't rely on:** social media posts, third-party blog posts (go stale fast), or your training data (API may have changed).

### Known-Engine Shortcut

If Batshit already has a verified engine playbook (like `chatterbox-turbo`), this research phase should be minimal. Do one quick primary-source confirmation if needed, then continue straight into the install lane. Don't burn turns on repeated web searches once the lane is known.

---

## Step 2: Answer These Questions

| Question | Why |
|---|---|
| How do you run it? (Python, Docker, binary) | Install path |
| Does it expose an HTTP API? | Batshit compatibility |
| What does the request look like? | `requestFormat` choice |
| What does the response look like? | Whether Batshit can handle it |
| Is it OpenAI-compatible? | Adapter lane option |
| What hardware does it need? | Whether user's machine can run it |
| How mature is it? | Register now or wait? |
| What bundled voices exist, and which languages do they cover? | `voiceSurface` / `voiceDiscovery` / default voice setup |
| What model variants and practical generation settings exist? | Whether to expose `uiSchema`, defaults, or a separate engine variant |
| Expression control? | `expression.strategy` |
| Does the weight source require auth? | Token conversation needed? |

If you can't answer all of these, you don't have enough info to pick a lane yet.

### User Scope Questions

Ask one to three short questions before installing when the answers affect the installed surface. Good examples:

- "Do you only want English voices, or should I include voices for another language too?"
- "This engine has a quality model and a faster model. Should I prioritize voice-chat responsiveness or best cloning quality?"
- "This engine needs reference audio for cloning. Do you want me to use its bundled/default reference voice first, or wait for your own authorized clip?"

Do not ask questions that the primary sources already answer. The goal is to avoid missing useful voices or installing the wrong model variant.

---

## Step 2b: Compare the Options

Before picking a lane, build a short internal comparison:

| Option | Source Quality | Platform Fit | Batshit Fit | Risk | Verdict |
|---|---|---|---|---|---|
| Official native | Primary source | Good/weak/bad | Good/weak/bad | Note | Best/fallback/reject |
| Verified MLX (if relevant) | Primary source | Good/weak/bad | Good/weak/bad | Note | Best/fallback/reject |
| Third-party wrapper | Third-party | Good/weak/bad | Good/weak/bad | Note | Best/fallback/reject |

Rules:
- Compare at least the official path and one realistic alternative
- On Apple Silicon, explicitly compare native vs any verified MLX path
- Reject options explicitly — don't just ignore them
- Don't pick an option simply because it was the first repo you found

### Apple Silicon MLX Cross-Check

If `macOS + arm64` and local TTS:
1. Check official `mlx-audio` supported-model list
2. If not listed, search `mlx-community` on Hugging Face
3. Only treat MLX as ready when the model card shows clear `mlx_audio` usage
4. If verified, present as preferred Mac performance option
5. If unclear, fall back to native lane

---

## Step 3: Look for Flags

### Green Flags (Probably Ready)
- Stable HTTP server mode
- Clear API docs with request/response examples
- Active maintenance, released for months
- Works on user's platform (confirmed)
- Pre-built Docker images or simple pip install

### Red Flags (Proceed with Caution)
- "Research preview" / "experimental"
- No HTTP server — only Gradio demo or Python calls
- Last commit months ago with open critical issues
- Single-platform only
- API changes between versions
- HuggingFace Space only, no standalone server
- Gated model download but docs bury the auth requirement

### Hard Stops (Don't Try Yet)
- No way to run as a server (Colab notebook only)
- Requires hardware the user can't get
- API completely undocumented
- Project appears abandoned

---

## Step 3b: Discuss the Recommendation

If there's more than one credible path, share a brief recommendation before mutating the machine:

> *"I checked the official repo and the Apple Silicon options. The verified MLX route is the best fit here — matches your hardware and keeps setup simpler. The fallback is the official native Python path. I recommend MLX. Any preference?"*

If the user already said "take the lead" — still share the recommendation, then proceed.

Don't stop at a vague research dump. The point is a short recommendation, not a handoff.

---

## Step 4: Pick One Lane

| Conclusion | Next Step |
|---|---|
| Engine is actually a hosted provider | Apply the built-in-only rule from main skill, stop BYO flow |
| Fits the Apple Silicon shared MLX path | Load `local-self-hosted-engines` + `mlx-audio-apple-silicon` |
| Fits the local/self-hosted path | Load `local-self-hosted-engines` |
| Genuinely OpenAI-compatible | Load `openai-compatible-adapter` |
| Needs a wrapper to expose HTTP | Build as part of local/self-hosted path |
| Not stable enough yet | Tell user plainly, suggest alternatives |

**Pick one and commit.** Don't half-follow multiple lanes. If the first choice turns out wrong, switch — but don't run two paths in parallel.

### Carrying Context Into the Lane

Once you identify the real runtime target, carry its contract:
- Python version from `pyproject.toml` / README
- Documented server entrypoint
- Auth requirements for model downloads

These aren't optional suggestions. If the repo says Python `>=3.11, <3.12`, use Python 3.11.

### After Picking

Move immediately:
- **Viable** → load the lane reference and continue the setup flow in the same response
- **Not viable** → stop with the blocker and alternatives now

Don't end with "I found the lane" unless you're actively continuing into it.

---

## Wrapping Engines Without HTTP Servers

Some great engines only expose a Python API, not an HTTP server. If otherwise solid, create a thin wrapper:

1. Small FastAPI or Flask server importing the engine
2. Expose `/tts`, `/health`, and optionally `/voices`
3. Install under `~/.batshit/installs/<engine-id>/`
4. Include a launch method

> *"Chatterbox doesn't have a built-in web server, so I'll create a small API wrapper for it. It'll live under `~/.batshit/installs/<engine-id>/` and give Batshit the HTTP endpoints it needs."*

Keep it minimal. Don't over-engineer.

Only build a custom wrapper when the engine truly doesn't have a maintained server repo.

---

## HuggingFace Spaces vs Real Integration

- A **Space is a demo** — it shows the engine working in a browser UI. Not an integration target.
- The **model behind the Space** might be great — but you need to run it locally or through an API, not through the Gradio interface.

> *"That Space is a demo of Kokoro TTS. We can't connect to the Space directly, but we can install Kokoro locally — same voice quality with full control."*

---

## Credential-Gated Downloads

Some "local" engines depend on third-party sources for weights. Hugging Face is the most common.

- Verify where real weights come from
- If HF and auth required, say so plainly
- Check for saved token in session context
- Ask permission before using it
- For managed installs, include `launch.envFromApiKeys` in the first helper payload — don't wait for an auth failure

---

## When to Do Web Research

Use web research (not training data) when:
- Engine released/updated after your knowledge cutoff
- README references a specific version you're unsure about
- Install instructions mention unfamiliar tools
- Best approach depends on what's true **today** for this machine

Web research is a strength, not a crutch. Use it proactively for fast-moving projects.

---

## Completion

This path ends with one of two conclusions — **not** a registration:

1. *"I compared the options and recommend [lane] because [reason]. Loading that reference now."*
2. *"This engine isn't stable enough to integrate yet. Here's why, and here are alternatives."*

If you reached conclusion 1, your next action is **mandatory**: load the lane reference immediately and keep going.
