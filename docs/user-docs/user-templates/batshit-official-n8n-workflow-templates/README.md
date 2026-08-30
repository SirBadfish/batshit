# Batshit Official n8n Workflow Templates

These are public-safe n8n Workflow Subagent templates for Batshit. They intentionally omit n8n credential IDs, secret values, source-instance ownership metadata, version metadata, and private local URLs.

## Templates

| File | Use |
| --- | --- |
| `batshit-n8n-workflow-subagent.json` | Host/local n8n Workflow Subagent for `API` and `CLI` Primary Agents. |
| `batshit-docker-n8n-workflow-subagent.json` | Docker-flavored Workflow Subagent for Batshit's optional Docker n8n profile. |

## Import and configure

Import the matching template through the n8n UI. Advanced users can also use `n8n import:workflow`; the templates include workflow-level IDs and were validated with n8n `2.22.1` CLI import in a clean disposable profile.

Configure these pieces manually:

- Provider credentials for the model node.
- Redis credentials if you use the included memory node.
- The Batshit Subagent Tools URL reachable from n8n.
- The production webhook URL saved in the matching Batshit Subagent.

Current templates use Batshit's short-lived `batshit_native_tool_token` payload value and send it as `x-batshit-native-tool-token`; no saved Header Auth credential is needed.

URL defaults:

- Host/local template: payload `batshit_frontend_url`, then `BATSHIT_FRONTEND_URL`, then `http://127.0.0.1:5620`.
- Docker template: the same priority, with `http://app:3000` as its fallback.

Source-checkout Batshit should set `BATSHIT_FRONTEND_URL=http://127.0.0.1:5621`.

## Payload contract

Workflow Subagents read Batshit's current payload fields:

- `user_id`
- `session_id`
- `message_id`
- `subagent_id`
- `subagent_slug`
- `parent_agent_id`
- `primary_agent_type`
- `subagentPrompts`
- `batshit_native_tool_token`
- `batshit_frontend_url`

Do not remove `parent_agent_id` or change `actor_type: subagent` in the tool context. Batshit uses those fields to resolve the parent-scoped permissions for the Subagent.

Batshit treats slugs as exact user-owned names. It refuses collisions instead of silently adding a suffix.

After the workflow is configured and active, create an `n8n Workflow Subagent` in Batshit, paste the Production webhook URL, and assign it to an `API` or `CLI` Primary Agent.

Batshit does not copy provider API keys into n8n. Keep n8n workflow credentials in n8n.
