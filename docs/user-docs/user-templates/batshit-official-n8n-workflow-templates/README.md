# Batshit Official n8n Workflow Templates

These are public-safe n8n workflow templates for Batshit n8n agents. They intentionally do not include n8n credential IDs, secret values, source instance ownership metadata, version metadata, or old local port assumptions.

## Templates

| File | Use |
| --- | --- |
| `batshit-n8n-primary-agent.json` | Main native n8n Primary Agent workflow. Use this first for n8n Primary agents. |
| `batshit-n8n-workflow-subagent.json` | Standalone n8n Workflow Subagent template for `API` and `CLI` Primary Agents. |
| `batshit-n8n-subnode-subagent-addon.json` | Advanced node snippet for explicitly wiring an assigned n8n Subnode Subagent into a Primary workflow. It imports as disconnected helper nodes; do not import this as the default Primary workflow. |
| `batshit-docker-n8n-primary-agent.json` | Docker-flavored Primary Agent template for Batshit's optional Docker n8n profile. |
| `batshit-docker-n8n-workflow-subagent.json` | Docker-flavored standalone Workflow Subagent template for Batshit's optional Docker n8n profile. |
| `batshit-docker-n8n-subnode-subagent-addon.json` | Docker-flavored Subnode Subagent add-on for Primary workflows in Batshit's optional Docker n8n profile. |

## Manual n8n Import

Import these templates directly in n8n, whether you use an existing n8n instance or Batshit's optional Docker n8n profile.

The normal path is n8n UI import. Advanced users can also use `n8n import:workflow`; these templates include workflow-level IDs and were validated with n8n `2.22.1` CLI import in a clean disposable profile.

You must manually create credentials and update URLs:

- Batshit Tools auth: current templates use Batshit's short-lived `batshit_native_tool_token` payload value and send it as `x-batshit-native-tool-token`; no saved Header Auth credential is needed for native tool dispatch.
- Redis credential: host `redis` inside Docker Compose, `localhost:5639` for local n8n beside Mac app Batshit, or `localhost:6379` for source-checkout repair Batshit.
- Batshit Tools HTTP Request Tool URL:
  - The native official templates use the per-message `batshit_frontend_url` payload first, then `BATSHIT_FRONTEND_URL` from the n8n environment, then local fallback `http://127.0.0.1:5620`.
  - The Docker official templates use the same runtime-url priority, but fall back to `http://app:3000` for Batshit's optional Docker n8n profile.
  - Docker optional n8n profile also sets `BATSHIT_FRONTEND_URL=http://app:3000`.
  - Local n8n beside Mac app Batshit can use the fallback or set `BATSHIT_FRONTEND_URL=http://127.0.0.1:5620`.
  - Local n8n beside a non-default Batshit instance should set `BATSHIT_FRONTEND_URL` to that instance's browser-facing app URL.
- Provider credentials for whichever hosted model providers the workflow should use.
- Agent ID / webhook path values that match the n8n agent record you create in Batshit.

## Batshit Payload Contract

The official templates use Batshit's current underscore field contract:

- Primary agents read `user_id`, `session_id`, `agent_id`, `chatInputText`, `batshit_image_inputs`, `batshit_image_urls`, and `selected_cli_tool_ids`.
- Workflow subagents read `user_id`, `session_id`, `subagent_id`, `subagent_slug`, and `parent_agent_id`.
- The default Primary template uses one Prepare node to convert Batshit `data:image/...` inputs into n8n binary image data before the native AI Agent node.

The default Primary template does not include a connected n8n Subnode Subagent. A connected n8n Agent Tool is visible to the model, so only copy the Subnode Subagent add-on nodes into a Primary workflow for a subagent that is assigned in Batshit. After import, connect the `n8n Subnode Subagent` tool output to the Primary workflow's native `AI Agent` only for that assigned subagent. The add-on uses the example slug `n8n_subnode_subagent`; if you intentionally use a different subnode slug, duplicate the add-on, or keep many subnode subagents, update every matching key in the add-on nodes to that subagent's current exact Batshit slug: the subnode system prompt, subnode model selector/model expressions, Batshit Subagent Tools context, and Redis memory key.

Batshit treats slugs as user-owned exact names. It does not silently add `_2` or rewrite a duplicate slug for you; if a slug is already taken, choose another slug or delete/rename the original.

An `n8n` Primary Agent only sees assigned in-workflow Subnode Subagents. It does not call the standalone Workflow Subagent webhook as a fallback. Standalone Workflow Subagent templates are for `API` and `CLI` Primary Agents.

After the workflow is imported and configured in n8n, create or edit the matching n8n Primary/Subagent record in Batshit. Paste the browser-facing webhook URL and n8n editor URL from n8n into the Batshit agent settings.

Batshit does not copy provider API keys into n8n. Keep n8n workflow credentials in n8n.
