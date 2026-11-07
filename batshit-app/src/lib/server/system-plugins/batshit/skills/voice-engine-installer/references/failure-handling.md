# Failure Handling

Use this when setup stops moving cleanly — installs fail, health checks fail, smoke tests fail, or the engine isn't behaving as expected. This reference helps you diagnose, communicate clearly, and either fix it or stop gracefully.

---

## The Two-Strikes Rule

If the same step fails twice without new information, **stop and report the blocker.**

- Don't keep rerunning the same command hoping for a different result
- Don't change unrelated settings as a workaround
- Don't enable the engine just to make the flow look complete
- Don't say "try again later" without explaining what went wrong

**"Without new information" means:** If you learn something new between failures (different error, found a missing dependency), that resets the counter. Same command, same error, twice = stop and diagnose.

**Apple Silicon MLX exception:** The known first-bootstrap dependency chain (`webrtcvad` → `pkg_resources` / `setuptools<81` → `fastapi` / `python-multipart`) counts as **one repair lane** where each retry reveals the next missing dependency. Only stop when the same repaired step fails again unchanged.

---

## Diagnosis Matrix

### Install Failures

| What Happened | Usually Means | What to Do |
|---|---|---|
| `pip install` build errors | Missing system dependency | Check which package failed, install the missing dep |
| `git clone` fails | Wrong URL, private repo, network issue | Verify URL, check auth |
| Docker image pull fails | Image doesn't exist, wrong tag, x86-only | Check exact image name and arch |
| Download fails (models/weights) | Disk space, network, or gated access | Check disk space; for gated models, user needs to accept license |
| Permission denied | Wrong directory permissions | Check target directory, macOS sandbox restrictions |

### Startup Failures

| What Happened | Usually Means | What to Do |
|---|---|---|
| Service exits immediately | Missing config, port conflict | Check error output for "address already in use" or config errors |
| Service starts, not reachable | Wrong host binding or port | Verify actual listening address; try `curl localhost:<port>/health` |
| Docker health fails | Service inside isn't ready yet | Wait and retry — some engines need startup time |
| Model loading errors | Missing/corrupt model files | Re-download, verify format |
| Health says `initializing` | First-run model download/warmup | Keep polling — this is progress, not failure |
| Health says `error` with a message | Runtime init failed after startup | Read the exact error, check the log, fix the specific issue |
| `timeout: command not found` (macOS) | Used a Linux-only helper | Use polling loop or tool's own timeout instead |
| `mlx_audio.server: command not found` | MLX runtime missing or wrong interpreter | Verify install, decide on Batshit-managed shared MLX, retry |
| `nvidia-smi` missing or no GPU found | CUDA prerequisite not met | Stop — NVIDIA/CUDA setup is outside this skill |
| `LocalTokenNotFoundError` / HF 401 | Gated model needs auth | Check for saved HF token, ask permission, use `launch.envFromApiKeys` |
| Perth/watermarker `NoneType` error on Mac Chatterbox | Wrong wrapper lane | Stop that wrapper, switch to official path + helper |

### Health Check Failures

| What Happened | Usually Means | What to Do |
|---|---|---|
| Connection refused | Service not running, wrong port | Verify service is up and port is correct |
| 401 / 403 | Auth token wrong or missing | Verify token and header format |
| 404 | Health path is wrong | Check actual endpoint from docs |
| 500 | Internal error | Check the service's own logs |
| Timeout | Overloaded or unreachable | Check load, verify URL |
| Unexpected response data | Not a real health endpoint | Pick a different endpoint or accept basic reachability |

### Smoke Test Failures

| What Happened | Usually Means | What to Do |
|---|---|---|
| Empty audio returned | Wrong request shape | Verify body matches what engine expects |
| Error response | Wrong field names or missing fields | Compare against API docs |
| Garbled audio | Wrong response format handling | Check audio encoding (raw bytes vs base64) |
| "OpenAI-compatible" TTS fails | Server isn't actually compatible | Switch to `batshit-byo` format |
| MLX model rejected | Model not actually ready for `mlx-audio` | Re-check support list, fall back to native lane |
| Voice discovery empty | Endpoint wrong or no catalog exists | Keep `voiceDiscovery.mode: "none"` |

---

## How to Communicate Failures

### Good

Be specific — what failed, why, and what the options are:

> *"Install failed: this engine requires CUDA, which your Mac doesn't have. Kokoro is a great alternative for Apple Silicon — want me to set that up?"*

> *"Health passed but TTS smoke failed — the engine expects a `speaker_id` field I wasn't sending. Let me fix the request and retry."*

> *"Same error twice trying to start the Docker container — image is x86-only and your Mac is ARM. Options: (1) a different engine that supports ARM, or (2) a hosted API instead."*

### Bad

Never leave the user hanging:

- "It should be fine now." *(Prove it.)*
- "Try refreshing." *(That's not a diagnosis.)*
- "Maybe it just needs a minute." *(Either wait and verify, or admit you don't know.)*
- "Let me try one more time." *(Only if you're doing something different.)*

---

## Recovery Strategies

### Wrong Request Format
1. Check actual API docs for correct shape
2. Switch `requestFormat` if needed
3. Update via `sys.voice.engine.update`
4. Re-run smoke test

### Wrong Endpoint Paths
1. Verify from docs or manual testing
2. Update paths via `sys.voice.engine.update`
3. Re-run health + smoke

### Auth Issues
1. Confirm token is correct and not expired
2. Verify header format
3. Update via `sys.voice.engine.update`
4. Re-run health

### Credential-Gated Downloads
1. Confirm weights come from a gated source (usually HF)
2. Explain plainly — don't frame as a mystery
3. Check for saved HF token, ask permission
4. For managed installs, use `launch.envFromApiKeys` — keep secrets server-side
5. Retry the helper with the approved mapping

### Hardware Incompatibility
1. Explain plainly why this engine can't run here
2. Suggest alternatives that work on this platform
3. Don't attempt workarounds that produce unusable results

### Service Won't Start
1. Check service logs
2. Verify dependencies installed
3. Check for port conflicts
4. Try a different port

---

## When to Give Up vs Keep Trying

**Keep trying:**
- Learned something new from the failure
- Fix is clear and untried
- Environmental issue (network hiccup, Docker restart)

**Give up:**
- Same error twice, no new info
- Engine fundamentally can't run on this hardware
- API too unstable/undocumented to register reliably
- 3-4 distinct fix attempts with no progress

**When you give up, always offer alternatives:**

> *"This engine won't work on your setup because [reason]. Here are alternatives:*
> - *[Alternative 1 — why it fits]*
> - *[Alternative 2 — why it fits]*
>
> *Want me to set one up?"*

---

## Existing Engine Troubleshooting

When a user comes in with a broken engine (not a new setup):

1. **Check registration** — `sys.voice.engine.health_check`
2. **Check if running** — is the service reachable?
3. **Check recent changes** — new IP, expired token, updated engine?
4. **Fix** — update registration, restart, fix auth
5. **Re-verify** — health + smoke after the fix
6. **Report** — what was wrong and what you fixed

> *"Your Kokoro engine was failing health checks. The server wasn't running — looks like it stopped after a reboot. I restarted it and it's healthy again. TTS smoke passed too."*
