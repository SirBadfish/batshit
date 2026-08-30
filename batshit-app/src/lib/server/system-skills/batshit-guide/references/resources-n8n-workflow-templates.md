# n8n workflow templates

Batshit uses n8n as an automation and tool platform. The official templates turn a whole n8n workflow into a specialist Subagent that an `API` or `CLI` Primary Agent can call.

The templates are starting points. They still need your own n8n credentials, provider choice, model node, and webhook URL before they are ready.

Batshit is alpha. Test every imported workflow before trusting it with important data.

## Official templates

The docs site publishes the current templates under `/user-templates/batshit-official-n8n-workflow-templates/`.

| Template | File | Use |
| --- | --- | --- |
| Batshit n8n Workflow Subagent | [`batshit-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-workflow-subagent.json) | Host/local n8n Workflow Subagent called by an `API` or `CLI` Primary Agent. |
| Batshit Docker n8n Workflow Subagent | [`batshit-docker-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-workflow-subagent.json) | Docker-flavored Workflow Subagent for Batshit's optional Docker n8n profile. |

## What you need first

- A running n8n instance: existing self-hosted n8n or Batshit's optional Docker n8n profile.
- Provider credentials inside n8n for the model node you plan to use.
- The correct Batshit URL from n8n's point of view.
- An `API` or `CLI` Primary Agent in Batshit.

The templates use the short-lived `batshit_native_tool_token` from each webhook payload for Batshit Subagent Tools calls, so you do not need a saved Batshit Header Auth credential.

## Choose the right URL

| Caller | Batshit app URL |
| --- | --- |
| Local n8n beside Mac app Batshit | `http://127.0.0.1:5620` |
| Local n8n beside source-checkout Batshit | `http://127.0.0.1:5621` |
| Optional Docker n8n profile | `http://app:3000` |
| Existing host n8n calling Docker Batshit | `http://127.0.0.1:5620` |
| Another container on the same Compose network | `http://app:3000` |

The Batshit Subagent Tools dispatch route is the app URL plus `/api/native-tools/dispatch`.

The official templates prefer the Batshit URL sent in the webhook payload, then `BATSHIT_FRONTEND_URL` from the n8n environment. The host/local template falls back to `http://127.0.0.1:5620`; source-checkout dev should use the launcher/env value `http://127.0.0.1:5621`; the Docker template falls back to `http://app:3000`.

## Import the template

1. Import [`batshit-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-workflow-subagent.json) into n8n. Use the Docker version for the optional Docker n8n profile.
2. Configure provider/model credentials in n8n.
3. Configure Redis memory if you want the workflow to use it.
4. Confirm the `Batshit Subagent Tools` HTTP Request Tool sends `x-batshit-native-tool-token` from `batshit_native_tool_token`.
5. Confirm its URL points to the Batshit app from n8n's point of view.
6. Save and activate the workflow.
7. Copy the Production webhook URL.
8. In Batshit, create an `n8n Workflow Subagent`.
9. Paste the production webhook URL into that Subagent.
10. Assign the Subagent to an `API` or `CLI` Primary Agent.
11. Test with a prompt that clearly asks the Primary Agent to call it.

## Workflow Subagent payload contract

The official templates use Batshit's underscore payload fields:

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

The `subagentPrompts` field contains the system prompt for the one Subagent Batshit is calling. Subagent slugs are exact names; Batshit refuses collisions instead of silently inventing another slug.

Do not remove `parent_agent_id` or change the template's actor type. Batshit uses those fields to resolve the parent agent's allowed tool scope.

## Batshit Subagent Tools in n8n

The HTTP Request Tool can expose the supported Subagent helper surface, including:

- `bash_execute`
- `native_skill`
- `batshit_tool_search`
- `batshit_tool_use`
- `runtime_addon_list`
- `runtime_addon_status`
- `runtime_addon_prepare`
- `runtime_addon_start`
- `runtime_addon_stop`
- `web_search`

`batshit_tool_search` returns labeled references for discoverable MCP tools, saved CLI Tools, published Artifact runtime tools, and Agent Browser capabilities. `batshit_tool_use` receives the exact reference returned by search.

Subagent tool scope is intentionally narrower than the parent Primary Agent. Subagents use their own Tool Grid and cannot fetch a prior Batshit Zip directly; have the Primary Agent fetch or summarize that context first.

## Redis memory

| n8n location | Redis host |
| --- | --- |
| Local n8n beside Mac app Batshit | `localhost`, port `5639` |
| Local n8n beside source-checkout Batshit | `localhost`, port `6379` |
| Optional Docker n8n profile | `redis`, port `6379` |

Docker Batshit's Redis is internal-only by default. An external host n8n cannot reach the Docker `redis` service unless you deliberately expose or route it.

## Advanced CLI import

Normal users should import templates through the n8n UI. For command-line operation:

```sh
n8n import:workflow --input /path/to/template.json
```

After import, open the workflow in n8n, create credentials, check URLs, activate it, and test it from Batshit.

## Test checklist

- The workflow is active.
- The Production webhook URL is saved in the Batshit Subagent.
- Provider credentials are selected on the model node.
- Batshit Subagent Tools sends `x-batshit-native-tool-token` from the payload.
- `parent_agent_id` remains in the tool context.
- The dispatch URL matches the n8n caller.
- An `API` or `CLI` Primary Agent can call the Subagent and receive its marker/result.
- A Subagent tool call renders in Batshit instead of appearing only in n8n logs.

## Support boundaries

- Batshit backups do not include external n8n workflows or n8n credentials.
- Export n8n workflows from n8n separately if you need a full n8n backup.
- Do not import workflows from untrusted sources without reading them.
- Provider credentials stay in n8n; Batshit API Keys are not copied into workflow credentials.
