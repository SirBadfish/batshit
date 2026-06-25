---
name: voice-engine-installer
description: Install, verify, and register Batshit TTS/STT speech engines from an outside coding agent using a Portable Skill Token.
metadata:
  version: "0.1.0"
  batshitPortableSkill: true
  family: voice-engines
---

# Batshit Portable Voice Engine Installer

You are running outside Batshit. Your job is to help the user install, verify, and register local or self-hosted TTS/STT engines in their local Batshit instance.

This portable skill uses Batshit's HTTP API. Do not write Redis directly. Do not edit Batshit app source. Do not use `BATSHIT_TOKEN`, user passwords, or n8n callback tokens.

## Required Inputs

Before doing real work, establish:

- Batshit base URL, defaulting to `http://127.0.0.1:5620`
- Portable Skill Token with the `Voice Engines` scope
- What the user wants to set up or troubleshoot

If the user has not provided the token, ask them to create one in Batshit Settings -> Skills & Prompts -> Portable Skills and grant `Voice Engines`. A multi-scope token may be stored once in `~/.batshit/portable-skills/portable-skills.env`; a skill-specific file such as `voice-engine-installer.env` is only needed when the user wants a narrower override token.

Use environment variables for shell calls so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/voice-engine-installer.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/voice-engine-installer.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

If `BATSHIT_PORTABLE_TOKEN` is missing or still equals the placeholder value, stop and ask the user for the token or env-file path before making API calls.

## Handshake

Run this before any install, mutation, or registration.

### 1. Health

```bash
curl -sS "$BATSHIT_BASE_URL/api/health"
```

Require `ok: true`. If Batshit is not reachable, stop and tell the user to start Batshit or provide the correct base URL.

### 2. Token Proof

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"controlId":"sys.runtime_addon.status","input":{"addonId":"voice-engines"}}'
```

Require a successful response. If the response says the token lacks scope, stop and tell the user to rotate or create a token with `Voice Engines`.

## Fabric Control Transport

In the in-app skill references, any instruction to call a Fabric control maps to this portable HTTP shape:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{
    "controlId": "sys.voice.engine.complete_local_setup",
    "input": {}
  }'
```

Portable Skill Tokens are the standing approval for the granted family. The server applies `allowRisky: true` for portable-token calls after family scope passes, so do not add parallel approval workarounds.

## Safety Boundary

- Never modify Batshit core source or app data roots.
- Never write direct Redis keys.
- Never register an engine before a real runtime is reachable.
- Never enable before health and smoke proof.
- Never install into system Python.
- Use `~/.batshit/installs/<engine-id>/` with an engine-local `.venv` for Batshit-managed Python engines.
- Keep model weights, Hugging Face caches, logs, configs, and helper files under the engine install root unless the user explicitly approved a shared cache/runtime and the launch env records that shared path.
- For Batshit-managed Hugging Face-backed installs, set `launch.env.HF_HOME` inside the engine install root, usually `~/.batshit/installs/<engine-id>/hf-home`, before any download or helper launch. If the user explicitly wants to reuse an existing shared cache, set `launch.env.HF_HOME` or `launch.env.HF_HUB_CACHE` to that exact path and set `launch.env.BATSHIT_ALLOW_SHARED_HF_CACHE = "true"`.
- Keep secrets server-side in the Engine Manager payload. Do not echo tokens into chat or put secrets in browser-visible fields.
- Engine deletion always removes saved clone profiles for that BYO provider. Pass `deleteLocalFiles: true` only when the user explicitly wants Batshit-managed local install/runtime files removed too; do not use it for connected existing or user-managed installs.
- For Docker Batshit, remember host-installed engines must be reachable from the app container, usually through `host.docker.internal`.

## Workflow

Follow this order:

1. Understand what the user wants.
2. Run `references/runtime-preflight.md`.
3. Route hosted-provider requests to Batshit's built-in provider settings instead of creating BYO duplicates.
4. For local/self-hosted requests, compare real paths and pick one.
5. Load the relevant engine playbook or lane reference.
6. Install or connect the runtime.
7. Verify health plus one real smoke test.
8. Read `references/expression-contract.md`.
9. Read `references/registration-patterns.md`.
10. Register disabled first, preferably through `sys.voice.engine.complete_local_setup` when the install is Batshit-managed.
11. Enable only after proof.
12. Report exactly what changed.

## Mandatory References

Always read:

- `references/runtime-preflight.md`
- `references/expression-contract.md`
- `references/registration-patterns.md`

Read engine or path references as needed:

- `references/chatterbox-turbo.md`
- `references/dots-tts-soar-mlx.md`
- `references/fish-speech-s2.md`
- `references/kyutai-local-tts.md`
- `references/nemotron-asr-mlx.md`
- `references/mlx-audio-apple-silicon.md`
- `references/local-self-hosted-engines.md`
- `references/local-stt-readiness.md`
- `references/openai-compatible-adapter.md`
- `references/open-source-engine-research.md`
- `references/failure-handling.md`

## Completion Report

End with:

- engine name and `byo:<engineId>`
- install location
- TTS/STT/clone capabilities
- health result
- smoke result
- expression strategy
- voice or transcription surface truth
- enabled/disabled status
- anything the user must still do

Do not call the setup done if any proof step failed.
