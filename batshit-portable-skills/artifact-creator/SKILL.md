---
name: artifact-creator
description: Build, validate, update, and publish Batshit artifacts from an outside coding agent using a Portable Skill Token.
metadata:
  version: "0.1.0"
  batshitPortableSkill: true
  family: artifacts
---

# Batshit Portable Artifact Creator

You are running outside Batshit. Your job is to help the user build, validate, update, publish, and place Batshit artifacts through the local Batshit HTTP API.

This portable skill uses Batshit's Fabric controls over HTTP. Do not write Redis directly. Do not edit Batshit app source. Do not use `BATSHIT_TOKEN`, user passwords, copied browser cookies, or n8n callback tokens.

## Required Inputs

Before doing real work, establish:

- Batshit base URL, defaulting to `http://127.0.0.1:5620`
- Portable Skill Token with the `Artifacts` scope
- what artifact the user wants created or changed
- whether this is a Mac/native instance or Docker Batshit when local runtimes, webhooks, or sidecars are involved

If the user has not provided the token, ask them to create one in Batshit Settings -> Skills & Prompts -> Portable Skills and grant `Artifacts`. A multi-scope token may be stored once in `~/.batshit/portable-skills/portable-skills.env`; a skill-specific file such as `artifact-creator.env` is only needed when the user wants a narrower override token.

Use environment variables for shell calls so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/artifact-creator.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/artifact-creator.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

If `BATSHIT_PORTABLE_TOKEN` is missing or still equals the placeholder value, stop and ask the user for the token or env-file path before making API calls.

## Handshake

Run this before any artifact mutation.

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
  --data '{"controlId":"sys.artifact.list","input":{}}'
```

Require a successful response. If the response says the token lacks scope, stop and tell the user to rotate or create a token with `Artifacts`.

## Fabric Control Transport

Any in-app instruction to call a Fabric control maps to this portable HTTP shape:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{
    "controlId": "sys.artifact.validate_structure",
    "input": {
      "content": "<artifact html>",
      "metadata": {}
    }
  }'
```

Use `/api/controls/find` when you need current schema details:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/find" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"query":"sys.artifact.create","includeSchema":true,"limit":5}'
```

Portable Skill Tokens are the standing approval for the granted family. Do not add parallel approval workarounds.

## Safety Boundary

- Never modify Batshit core source, Redis, app data roots, or packaged runtime files.
- Author local draft files only in the outside-agent workspace or another user-approved working folder.
- Keep API keys and provider secrets in Batshit server-side settings or Artifact configuration. Do not paste secrets into artifact HTML, chat text, or downloaded bundles.
- For built-in AI artifacts, use `sys.model_catalog.search` and store the exact returned artifact model config when the model is known. Never silently choose a fallback model.
- Saves (`create`, `update`, `apply_patch`, `publish`) run the Builder Kit, Fabric, and field-name checks themselves and refuse with a list of what to fix: fix those and send the save again. `sys.artifact.validate_structure` gives the same verdict without saving, for a dry run of a risky edit.
- Respect the Builder Kit plus Fabric contract: use `window.batshit.builder.*`, declare `metadata.fabric_fields`, or set `metadata.run_only=true` for trigger-only artifacts.
- Give every field a visible `label` (the Builder Kit links it to the control so a screen reader can name it; `ariaLabel` only for a field that shows no label). A save refuses a new field without a name.
- For `sys.artifact.apply_patch`, send one managed patch string against `artifact.html`. Do not send unified diff headers or JSON patch objects.
- A `sys.artifact.update` with `content`, or a `sys.artifact.add_version`, replaces the whole page, so it must carry `expectedVersion`: the `version` of your last result that loaded the whole page or wrote your own whole content (a `get` with content, `create`, a `content` update, or `add_version`), never an apply_patch, publish, zone, webhook, metadata, field, or rollback result: those show the stored version of a page you may not have read in full (a patch applies to the stored text, so a user's save elsewhere can sit in it), so `get` the artifact again before your next full-content write. If the user or another agent saved a newer version, the update is refused and nothing is saved: `get` the artifact again, redo your edit on that content, and send the new version. A `sys.artifact.update` without `content` needs no version.
- For Docker Batshit, resolve URLs by caller. Host services normally need app-container URLs such as `host.docker.internal`; browser/iframe URLs may still be `localhost`.

## Workflow

Follow this order:

1. Understand what the user wants and whether this is a new artifact or an edit.
2. If editing, call `sys.artifact.list`, then `sys.artifact.get`, and read `references/editing.md`.
3. Load the references the build needs before coding. Each opens with a "Load when" line; read only what applies:
   - native artifact (static, Built-in AI, or a webhook UI): `references/brain-general.md` and `references/builder-kit-api.md`, plus `references/ai-capabilities.md` and `references/ai-models.md` for Built-in AI
   - ComfyUI workflow: `references/brain-comfyui.md`, then `references/comfyui-build.md`
   - n8n workflow: `references/brain-n8n.md`
   - HuggingFace path: `references/brain-huggingface.md`
   - standalone Gradio embed: `references/embed-gradio.md`
4. Author or patch the artifact locally.
5. Create it with one `sys.artifact.create` that carries everything (`metadata`, `brain_type`, `zone`, `icon_ref`, `model_config` and `system_prompt` for Built-in AI, and `mode: "published"` when it should be usable now), or change it with `sys.artifact.update` (with `expectedVersion` when it sends `content`) / `sys.artifact.apply_patch`. A refused save lists what to fix.
6. If the artifact runs AI or a webhook, run it once when practical and inspect `sys.artifact.run_logs.list` / `sys.artifact.run_logs.get`. `references/fabric-and-agent-use.md` covers agent access and failed runs.
7. Report exactly what changed and where the user can find it.

## Available Controls

- `sys.artifact.list`
- `sys.artifact.get`
- `sys.artifact.create`
- `sys.artifact.update`
- `sys.artifact.apply_patch`
- `sys.artifact.validate_structure`
- `sys.artifact.publish`
- `sys.artifact.add_version`
- `sys.artifact.delete_version`
- `sys.artifact.rollback`
- `sys.artifact.set_zone`
- `sys.artifact.set_webhook`
- `sys.artifact.analyze_url`
- `sys.artifact.check_requirements`
- `sys.artifact.run_logs.list`
- `sys.artifact.run_logs.get`
- `sys.model_catalog.search`

## References

Read the build-path references named in the workflow before writing artifact HTML; each reference's first lines say when to load it:

- `references/ai-capabilities.md`
- `references/ai-models.md`
- `references/brain-comfyui.md`
- `references/brain-general.md`
- `references/brain-huggingface.md`
- `references/brain-n8n.md`
- `references/builder-kit-api.md`
- `references/comfyui-build.md`
- `references/comfyui-reference.md`
- `references/editing.md`
- `references/embed-gradio.md`
- `references/fabric-and-agent-use.md`
- `references/n8n-troubleshooting.md`
- `references/runtime-api.md`
- `references/runtime-location.md`
- `references/templates-gallery.md`
- `references/zone-patterns.md`

## Completion Report

End with:

- artifact name and ID
- new vs updated
- artifact power source
- zone and published status
- save result (and any refusal you fixed)
- model or runtime URL truth when relevant
- run-log evidence when relevant
- anything the user must still do

Do not call the artifact done if the save was refused or the intended runtime cannot be reached.
