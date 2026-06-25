---
name: cli-tool-creator
description: Create, update, validate, and review Batshit CLI Tools from an outside coding agent using a Portable Skill Token.
metadata:
  version: "0.1.0"
  batshitPortableSkill: true
  family: cli-tools
---

# Batshit Portable CLI Tool Creator

You are running outside Batshit. Your job is to help the user turn an installed command, script, or local program into a clean Batshit CLI Tool record.

This portable skill uses Batshit's Fabric controls over HTTP. Do not write Redis directly. Do not edit Batshit app source. Do not use `BATSHIT_TOKEN`, user passwords, copied browser cookies, or n8n callback tokens.

## Required Inputs

Before doing real work, establish:

- Batshit base URL, defaulting to `http://127.0.0.1:5620`
- Portable Skill Token with the `CLI Tools` scope
- command, script, or program the user wants registered
- where Batshit will execute it: Mac/native host, Docker app container, configured worker, or sidecar

If the user has not provided the token, ask them to create one in Batshit Settings -> Skills & Prompts -> Portable Skills and grant `CLI Tools`. A multi-scope token may be stored once in `~/.batshit/portable-skills/portable-skills.env`; a skill-specific file such as `cli-tool-creator.env` is only needed when the user wants a narrower override token.

Use environment variables for shell calls so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/cli-tool-creator.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/cli-tool-creator.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

If `BATSHIT_PORTABLE_TOKEN` is missing or still equals the placeholder value, stop and ask the user for the token or env-file path before making API calls.

## Handshake

Run this before any tool mutation.

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
  --data '{"controlId":"sys.cli_tool.list","input":{}}'
```

Require a successful response. If the response says the token lacks scope, stop and tell the user to rotate or create a token with `CLI Tools`.

## Fabric Control Transport

Any in-app instruction to call a Fabric control maps to this portable HTTP shape:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/use" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{
    "controlId": "sys.cli_tool.create",
    "input": {}
  }'
```

Use `/api/controls/find` when you need current schema details:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/find" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"query":"sys.cli_tool.create","includeSchema":true,"limit":5}'
```

Portable Skill Tokens are the standing approval for the granted family. Confirm-level controls such as `sys.cli_tool.test` run through the same endpoint after scope passes.

## Safety Boundary

- Never modify Batshit core source, Redis, app data roots, or packaged runtime files.
- Inspect tools with read-only commands first: `command -v`, `which`, `--help`, `-h`, `--version`, or direct file reads.
- Do not run the tool's real write/network behavior during inspection.
- Do not register a host-only executable for Docker Batshit unless the selected runtime can actually execute it.
- When a tool writes files, set honest write permissions and allowed paths.
- When a tool uses network or secrets, make that visible in the manifest and risk level.
- Store saved-key references, not secret values.
- Prefer updating an existing matching tool over creating duplicates.
- Always run `sys.cli_tool.test` unless the user explicitly says not to.

## Workflow

Follow this order:

1. Understand what command or script the user means and what job it should do.
2. Identify where Batshit will execute it. For Docker, host-installed commands are not automatically available inside the app container.
3. Inspect the tool safely using read-only commands from the correct runtime whenever possible.
4. Infer the manifest:
   - `title`
   - `description`
   - `executable`
   - `argsTemplate`
   - `inputSchema`
   - `outputMode`
   - `parseMode`
   - risk, network, write, cwd, env refs, timeout, tags, icon, and validation input when relevant
5. Call `sys.cli_tool.list` and update an existing matching tool when appropriate.
6. Save with `sys.cli_tool.create` or `sys.cli_tool.update`.
7. Run `sys.cli_tool.test` with the saved `toolId`.
8. Report exactly what changed and whether a companion Batshit skill would help.

## Args Template Reference

Use structured entries, not one raw shell string:

- literal: `{ "kind": "literal", "value": "--json" }`
- input: `{ "kind": "input", "field": "inputFile", "required": true }`
- option: `{ "kind": "option", "flag": "--format", "field": "format" }`
- flag: `{ "kind": "flag", "flag": "--verbose", "field": "verbose" }`
- repeat: `{ "kind": "repeat", "field": "files", "flag": "-i" }`

Path inputs should use JSON Schema `"format": "path"` when Batshit path safety matters.

## Available Controls

- `sys.cli_tool.list`
- `sys.cli_tool.get`
- `sys.cli_tool.create`
- `sys.cli_tool.update`
- `sys.cli_tool.test`
- `sys.cli_tool.archive`
- `sys.cli_tool.delete`

## Completion Report

End with:

- CLI Tool name and `toolId`
- executable and runtime location
- what inputs it accepts
- output mode and parse mode
- risk/network/write/secret notes
- validation test result
- whether a companion skill is recommended
- where the user can find it in Batshit

Do not call the tool done if the saved record cannot be validated.
