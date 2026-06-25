---
name: skill-creator
description: Create, update, and import Batshit skills or prompt commands from an outside coding agent using a Portable Skill Token.
metadata:
  version: "0.1.0"
  batshitPortableSkill: true
  family: skills
---

# Batshit Portable Skill Creator

You are running outside Batshit. Your job is to help the user design, write, validate, save, or import Batshit skills and prompt commands.

This portable skill uses Batshit's Fabric controls over HTTP. Do not write Redis directly. Do not edit Batshit app source. Do not use `BATSHIT_TOKEN`, user passwords, copied browser cookies, or n8n callback tokens.

## Required Inputs

Before doing real work, establish:

- Batshit base URL, defaulting to `http://127.0.0.1:5620`
- Portable Skill Token with the `Skills` scope
- whether the user wants a Skill or a Prompt
- whether this is new, an update, or an import

If the user has not provided the token, ask them to create one in Batshit Settings -> Skills & Prompts -> Portable Skills and grant `Skills`. A multi-scope token may be stored once in `~/.batshit/portable-skills/portable-skills.env`; a skill-specific file such as `skill-creator.env` is only needed when the user wants a narrower override token.

Use environment variables for shell calls so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/skill-creator.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/skill-creator.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

If `BATSHIT_PORTABLE_TOKEN` is missing or still equals the placeholder value, stop and ask the user for the token or env-file path before making API calls.

## Handshake

Run this before any save or import.

### 1. Health

```bash
curl -sS "$BATSHIT_BASE_URL/api/health"
```

Require `ok: true`. If Batshit is not reachable, stop and tell the user to start Batshit or provide the correct base URL.

### 2. Token Proof

The `Skills` family intentionally has no harmless list/get control in v1. Prove the token with scoped control discovery instead of making a fake save:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/find" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"query":"sys.skill.save","includeSchema":true,"limit":5}'
```

Require a successful response containing `sys.skill.save`. If the response is unauthorized or empty because of scope, stop and tell the user to rotate or create a token with `Skills`.

## Fabric Control Transport

Any in-app instruction to call a Fabric control maps to this portable HTTP shape:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{
    "controlId": "sys.skill.save",
    "input": {}
  }'
```

Use `/api/controls/find` with `includeSchema: true` before saving if the compact hints are not enough.

Portable Skill Tokens are the standing approval for the granted family. Confirm-level imports still go through `/api/controls/use` after scope passes.

## Safety Boundary

- Never modify Batshit core source, Redis, app data roots, or packaged runtime files.
- Never overwrite protected system skills. If Batshit rejects a save because the target is protected, explain that system skills are product-owned.
- Never silently overwrite an existing custom skill or prompt. Confirm updates with the user.
- Never store secrets in SKILL.md, prompt text, references, scripts, or bundle files.
- For imports, use public HTTPS or user-approved local folders only. Do not import private SSH URLs or private-network sources.
- Make dependencies explicit. If a skill depends on CLI tools, artifacts, MCPs, Docker sidecars, or voice engines, say where they run and how to prove them.
- Keep prompts written from the user's voice and skills written for the agent.

## Workflow

Follow this order:

1. Decide whether the user wants a Prompt or a Skill.
2. For Skills, read `references/writing-for-llms.md` unless the skill is very small and obvious.
3. Draft the content locally in the outside-agent workspace.
4. Validate names, frontmatter, descriptions, dependencies, allowed tools, and references.
5. Show the user what will be saved and get explicit approval before calling `sys.skill.save` or `sys.skill.import`.
6. Save with `sys.skill.save`, or import with `sys.skill.import` when the user wants to bring in an existing bundle.
7. If Batshit reports a protected-system-skill failure, stop and explain that the system skill cannot be changed from a portable agent.
8. Report how to invoke or enable the result.

## Skill Or Prompt Decision

Use this plain-language distinction:

- Prompt: reusable text from the user's point of view, inserted into messages.
- Skill: reusable instructions for the agent to learn and follow.

Ask one short question when the type is unclear: "Do you want reusable text inserted into your messages, or instructions your agent reads to learn a workflow?"

## Available Controls

- `sys.skill.save`
- `sys.skill.import`

## Mandatory Reference

- `references/writing-for-llms.md`

## Completion Report

End with:

- command or prompt name
- type: Skill or Prompt
- invocation pattern
- dependencies or required tools
- whether it is enabled for all agents or selected agents
- save/import result
- any user action still needed

Do not call the work done until Batshit confirms the save or import succeeded.
