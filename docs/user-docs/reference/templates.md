# Templates

This page lists the public-safe template files published by the docs site under `/user-templates/`.

## Current template rule

Import workflow templates in n8n. Batshit does not silently provision n8n workflows, credentials, provider keys, or model nodes for the user.

For n8n workflows:

- Create credentials in n8n.
- Configure provider/model nodes in n8n.
- Use the official Batshit Tools node's scoped `x-batshit-native-tool-token` header for native tool dispatch.
- Paste browser-facing webhook URLs into the matching Batshit agent or subagent settings.
- Keep n8n provider credentials in n8n. Batshit Settings -> API Keys does not copy provider keys into n8n.

## Current public-safe n8n agent templates

These are the current launch-facing source templates:

| File | Workflow name | Use |
| --- | --- | --- |
| [`batshit-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-primary-agent.json) | Batshit n8n Primary Agent | Main native `n8n` Primary Agent workflow. Use this first for `n8n` Primary Agents. |
| [`batshit-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-workflow-subagent.json) | Batshit n8n Workflow Subagent | Standalone `n8n Workflow Subagent` template for `API` and `CLI` Primary Agents. |
| [`batshit-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-subnode-subagent-addon.json) | Batshit n8n Subnode Subagent Add-on | Advanced node snippet for explicitly wiring an assigned n8n Subnode Subagent into a Primary workflow. |
| [`batshit-docker-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-primary-agent.json) | Batshit Docker n8n Primary Agent | Docker-flavored `n8n` Primary Agent workflow for Batshit's optional Docker n8n profile. |
| [`batshit-docker-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-workflow-subagent.json) | Batshit Docker n8n Workflow Subagent | Docker-flavored standalone `n8n Workflow Subagent` template for Batshit's optional Docker n8n profile. |
| [`batshit-docker-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-subnode-subagent-addon.json) | Batshit Docker n8n Subnode Subagent Add-on | Docker-flavored add-on snippet for explicitly wiring an assigned n8n Subnode Subagent into a Docker Primary workflow. |

These files are intended to be public-safe. They do not include credential IDs, secret values, source instance ownership metadata, source instance version metadata, or private local port assumptions.

Normal users should import these through the n8n UI. The templates also include workflow-level IDs and have been validated with `n8n import:workflow` on n8n `2.22.1` in a clean disposable n8n profile, but UI import remains the clearest public setup path.

## Required n8n credentials

After import, create or select these credentials in n8n:

| Credential | Needed for | Native value | Docker optional n8n profile value |
| --- | --- | --- | --- |
| Redis credential | Subagent/workflow memory where used | Mac app: host `localhost`, port `5639`; source-checkout repair: host `localhost`, port `6379`. | Host `redis`, port `6379` inside Compose. |
| Provider credentials | Chat model nodes in n8n | Create in n8n for the providers used by the workflow. | Create in n8n for the providers used by the workflow. |

Current official agent templates do not need a saved Header Auth credential for Batshit Tools. Batshit sends each chat request a short-lived native-tool token in the webhook payload, and the Batshit Tools nodes forward it as `x-batshit-native-tool-token`.

## Tool dispatch URL

The templates include HTTP Request Tool nodes that call Batshit's native tool dispatch route. They use the per-message `batshit_frontend_url` payload first, then `BATSHIT_FRONTEND_URL` from the n8n environment. Native templates fall back to the Mac app/common local URL `http://127.0.0.1:5620`; source-checkout dev should use the launcher/env value `http://127.0.0.1:5621`; Docker templates fall back to `http://app:3000`. Use the URL reachable from n8n:

| n8n location | Batshit Tools URL |
| --- | --- |
| Local n8n beside Mac app Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| Local n8n beside source-checkout dev Batshit | `http://127.0.0.1:5621/api/native-tools/dispatch` |
| Optional Docker n8n profile | `http://app:3000/api/native-tools/dispatch` |
| Host-managed n8n calling Docker Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |

## Webhook URLs to paste into Batshit

Use browser-facing webhook URLs in Batshit settings because the browser/user-facing agent record should show a URL the user can inspect.

| Template | Default webhook path | Browser-facing example |
| --- | --- | --- |
| Batshit n8n Primary Agent | `batshit_n8n_primary` | `http://localhost:5678/webhook/batshit_n8n_primary` |
| Batshit n8n Workflow Subagent | `batshit_n8n_workflow_subagent` | `http://localhost:5678/webhook/batshit_n8n_workflow_subagent` |
| Batshit Docker n8n Primary Agent | `batshit_docker_n8n_primary` | `http://localhost:5678/webhook/batshit_docker_n8n_primary` |
| Batshit Docker n8n Workflow Subagent | `batshit_docker_n8n_workflow_subagent` | `http://localhost:5678/webhook/batshit_docker_n8n_workflow_subagent` |

For optional Docker n8n profile on a custom host port, use that custom browser URL when pasting into Batshit. The Docker runtime rewrites server-side calls to the Docker-reachable n8n URL where needed.

## Agent and subagent pairing

| Batshit thing | Uses which template |
| --- | --- |
| `n8n` Primary Agent | Batshit n8n Primary Agent template. |
| `n8n Subnode Subagent` | Explicit add-on nodes copied into an `n8n` Primary Agent workflow only when that subagent is assigned in Batshit. This pairs only with `n8n` Primary Agents. The official add-on uses the example Batshit subagent slug `n8n_subnode_subagent`. |
| `n8n Workflow Subagent` | Batshit n8n Workflow Subagent template. This pairs with `API` and `CLI` Primary Agents. |
| `API Subagent` | Batshit-managed direct subagent, not an n8n workflow template. |
| `CLI Subagent` | Batshit-managed CLI subagent, not an n8n workflow template. |

`n8n` Primary Agents only call assigned in-workflow Subnode Subagents. They do not fall back to the standalone Workflow Subagent webhook.

The default Primary template intentionally does not expose any Subnode Subagent. Do not rely on prompt instructions to hide connected Agent Tool nodes; only wire the add-on when the subagent is assigned.

## n8n expression contract

The official n8n agent templates intentionally use Batshit's current underscore payload fields instead of broad fallback chains. Primary workflow tool nodes read `user_id`, `session_id`, `agent_id`, and `selected_cli_tool_ids`. Workflow Subagent nodes read `user_id`, `session_id`, `subagent_id`, `subagent_slug`, and `parent_agent_id`.

Primary workflows also read `chatInputText`, `batshit_image_inputs`, and `batshit_image_urls`. The official native Primary template converts Batshit image data URIs into n8n binary image fields in its Prepare node, then relies on the native AI Agent node's binary image passthrough. Base64 image bytes stay out of the model-facing text prompt.

Subagent slugs are exact names. Batshit will not silently add `_2` or invent a different slug when one is already taken; it will show a collision error so you can choose another slug or delete/rename the original.

Only n8n Subnode Subagents need a fixed subagent key inside the workflow add-on. In the official add-on that key is `n8n_subnode_subagent`, and it is used for the subnode system prompt, subnode model selector/model expressions, Batshit Subagent Tools context, and Redis memory key. If you use a different slug, duplicate the add-on, or make multiple subnode subagents in one Primary Agent workflow, update every matching expression to the current exact Batshit slug for that subagent. Each subnode needs its own unique slug in those same places.

## Template import checklist

Use this checklist after importing a template into n8n:

- Workflow imports without missing-node errors.
- Batshit Tools sends `x-batshit-native-tool-token` from `batshit_native_tool_token`.
- Redis credential points to the correct Redis host for native or Docker.
- Provider credentials are created in n8n.
- Model/provider nodes are configured in n8n.
- Batshit Tools URL matches the n8n caller location.
- Webhook path matches the Batshit agent/subagent record.
- Browser-facing webhook URL is pasted into Batshit settings.
- Workflow is activated in n8n before testing from Batshit.

## Backup and sharing notes

Batshit app backups do not silently include external n8n workflows or n8n credentials. Export n8n workflows from n8n when you need an n8n backup.

Before sharing a workflow export:

- Remove credential IDs.
- Remove secret values.
- Remove source instance metadata that identifies a private n8n instance.
- Replace local paths and private URLs with placeholders.
- Confirm the workflow uses current Batshit names and current ports.
