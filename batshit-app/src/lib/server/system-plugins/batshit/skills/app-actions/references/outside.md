# App Actions from outside Batshit

First ask Batshit for the current controls relevant to this job with `POST /api/controls/find`, using `x-batshit-portable-token` and `includeSchema: true`; it returns only controls permitted by your token. Keep this guide's own scope and safety rules.

Use this guide to inspect or change supported Settings on a running Batshit instance. Your App Actions token family permits only `sys.app_settings.portable.report` and `sys.app_settings.portable.change`. It cannot run the in-app screen controls. Settings reports and changes do not require an open Batshit window.

Before calls, establish the instance's base URL and a Portable Skill Token with a current App Actions subject/effect grant and expiry. The user manages this in **Settings → Plugins & shit → Portable Skills**. The family checkbox alone does not grant Settings authority. The token holder is the actor; granted agents are subjects, so never supply an acting `agentId` or pretend to be the agent.

Use environment variables so the token is not repeated in every command:

```bash
PORTABLE_SKILL_ENV_DIR="${BATSHIT_PORTABLE_SKILL_ENV_DIR:-$HOME/.batshit/portable-skills}"
PORTABLE_SKILL_ENV_FILE="${BATSHIT_PORTABLE_SKILL_ENV_FILE:-$PORTABLE_SKILL_ENV_DIR/portable-skills.env}"
if [ -z "${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}" ]; then
  if [ -f "$PORTABLE_SKILL_ENV_FILE" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_FILE"
    set +a
  elif [ -f "$PORTABLE_SKILL_ENV_DIR/app-actions.env" ]; then
    set -a
    . "$PORTABLE_SKILL_ENV_DIR/app-actions.env"
    set +a
  fi
fi
export BATSHIT_BASE_URL="${BATSHIT_BASE_URL:-http://127.0.0.1:5620}"
export BATSHIT_PORTABLE_TOKEN="${BATSHIT_PORTABLE_TOKEN:-${BATSHIT_PORTABLE_SKILL_TOKEN:-}}"
```

The Mac app's usual address is `http://127.0.0.1:5620`; confirm the actual instance rather than replacing a supplied address. If `BATSHIT_PORTABLE_TOKEN` is still missing or a placeholder after this, stop and ask the user for the token or env-file path. Do not print, commit or put the secret in a URL.

## Connect and discover

1. Read `GET /api/health`; require `ok: true`. If unreachable, ask for the correct running instance.
2. First ask Batshit for the current controls relevant to this job with `POST /api/controls/find`, using `x-batshit-portable-token`. Discovery is filtered to that token's permitted controls; it does not grant a missing capability. Request the current schemas:

```bash
curl -sS "$BATSHIT_BASE_URL/api/controls/find" \
  -H "Content-Type: application/json" \
  -H "x-batshit-portable-token: $BATSHIT_PORTABLE_TOKEN" \
  --data '{"query":"sys.app_settings.portable","domain":"agent-settings","includeSchema":true,"limit":10}'
```

Require `success: true` and the intended control in `results`. Each item includes `controlId`, `schemaHint` and, with `includeSchema: true`, `inputSchema`. `totalMatches` and `limit` describe this search, not every tool on the instance. If authentication fails or the needed control is absent, explain the missing or expired access and stop that operation; do not try another credential or route.

## Read, then change

Execute a discovered control through `POST /api/controls/use` with the same token header and a JSON body containing its bare `controlId` and schema-correct `input`. Do not send a native broker's `fabric:` prefix as the HTTP `controlId`.

For example, after discovery, read one exact granted Primary's name using its real ID:

```json
{
  "controlId": "sys.app_settings.portable.report",
  "input": {
    "domain": "agent-settings",
    "targets": {"subjects": [{"kind": "primary", "id": "<exact-granted-agent-id>"}]},
    "focus": ["agent.identity"],
    "detail": "values"
  }
}
```

The example ID is a placeholder, never a request to send unchanged. The HTTP response's `result` contains the Settings result; inspect its status as well as the outer `success`.

Read the relevant values or choices before changing them. Keep the returned report's exact subjects and exclusions, use its `reportId` and reported change instructions, and choose only fields the current schema and grant admit. Use the report's `bootNamespace` when making its unique `requestId`. Continue a held report with only its `reportId` and returned cursor. Missing, invalid, blocked and unknown data are not defaults. A fresh report is required after expiry, conflict or changed authority before a new change is prepared.

The portable change control also checks an existing operation with `{"op":"outcome","operationId":"<returned-operation-id>"}` and requests cancellation with `{"op":"cancel","operationId":"<returned-operation-id>"}`. Use only the actual returned operation ID. Cancellation does not prove an issued write was undone.

## Approval and results

If a change returns `user_approval_required`, give the user the returned `reviewUrl` on this Batshit instance and explain the exact change. Only the signed-in user can approve or deny that review. Opening the page does not approve it; the token's family scope does not replace the decision. After the user's decision, inspect that same operation's outcome. Never approve through another credential or create a replacement write while waiting.

Report each subject's actual outcome. A successful HTTP/control response may still contain blocked, pending or unknown Settings results. A saved value does not prove a panel refreshed, a provider account is entitled, audio works or a runtime is ready. After an uncertain answer, inspect the existing operation; do not resubmit the write or automatically roll it back. If no usable operation ID returned, report the uncertainty and stop the dependent change.

Use only health and the two control routes. Never use service tokens, passwords, copied browser cookies, n8n callback tokens, direct Redis, core-source edits or app-data writes. Do not widen grants, expose secret values or turn an unavailable field into a raw settings-path edit. Existing independent-skill access may be offered within the grant; plugin access remains user-managed. Runtime inspection is read-only. This guide grants no CLI setup, native activation, install, login or automatic continuation authority.
