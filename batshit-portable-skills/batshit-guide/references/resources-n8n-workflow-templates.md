# n8n workflow templates

Batshit can use n8n two ways:

- **`n8n` Primary Agents** — you chat directly with an n8n workflow.
- **n8n workflows as tools** — `API` and `CLI` Primary Agents call n8n workflows when they need automation.

The templates in this folder are starting points. They still need your own n8n credentials, provider choices, agent IDs, and webhook URLs before they're ready.

Launch note: Batshit is alpha. These templates save setup time, but test every imported workflow before trusting it with important data.

## Official templates

The current launch-facing templates are published by the docs site under `/user-templates/batshit-official-n8n-workflow-templates/`.

| Template | File | Use |
| --- | --- | --- |
| Batshit n8n Primary Agent | [`batshit-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-primary-agent.json) | Main `n8n` Primary Agent workflow. Start here to chat with an n8n agent directly. |
| Batshit n8n Workflow Subagent | [`batshit-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-workflow-subagent.json) | n8n Workflow Subagent called by an `API` or `CLI` Primary Agent. |
| Batshit n8n Subnode Subagent Add-on | [`batshit-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-subnode-subagent-addon.json) | Advanced copy/paste add-on for explicitly assigned Subnode Subagents inside an `n8n` Primary workflow. Don't import it as a standalone workflow. |
| Batshit Docker n8n Primary Agent | [`batshit-docker-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-primary-agent.json) | Docker-flavored Primary Agent workflow for the optional Docker n8n profile. |
| Batshit Docker n8n Workflow Subagent | [`batshit-docker-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-workflow-subagent.json) | Docker-flavored Workflow Subagent template for the optional Docker n8n profile. |
| Batshit Docker n8n Subnode Subagent Add-on | [`batshit-docker-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-subnode-subagent-addon.json) | Docker-flavored copy/paste add-on for Subnode Subagents inside a Docker n8n Primary workflow. |

## What you need first

Before importing templates, have these ready:

- A running n8n instance — your existing self-hosted n8n or Batshit's optional Docker n8n profile.
- Provider credentials inside n8n for the model nodes you plan to use.
- The correct Batshit URL for the caller that will reach Batshit.

The official templates use the short-lived `batshit_native_tool_token` from each webhook payload for Batshit Tools calls, so you don't need a saved Batshit Header Auth credential.

For the optional Docker n8n profile, the default profile uses an official pinned n8n image. You still import templates and create credentials manually in n8n.

## Choose the right URL

Most n8n setup problems are URL problems. Use the URL from the point of view of the service making the request.

| Caller | Batshit app URL to use |
| --- | --- |
| Browser on your computer using Mac app Batshit | `http://127.0.0.1:5620` |
| Browser using Docker Batshit | `http://localhost:5620` |
| Browser using source-checkout dev Batshit | `http://localhost:5621` |
| Local n8n on the same computer as Mac app Batshit | `http://127.0.0.1:5620` |
| Local n8n on the same computer as source-checkout dev Batshit | `http://127.0.0.1:5621` |
| Optional Docker n8n profile calling the Docker app | `http://app:3000` |
| Existing host n8n calling Docker Batshit through the published port | `http://127.0.0.1:5620` |
| Another container on the same Compose network calling the Docker app | `http://app:3000` |

For the Batshit Tools HTTP Request Tool:

| n8n placement | URL |
| --- | --- |
| Local n8n with Mac app Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| Local n8n with source-checkout dev Batshit | `http://127.0.0.1:5621/api/native-tools/dispatch` |
| Optional Docker n8n profile | `http://app:3000/api/native-tools/dispatch` |
| Host n8n calling Docker Batshit | `http://127.0.0.1:5620/api/native-tools/dispatch` |

The official templates prefer the Batshit URL sent in the webhook payload, then `BATSHIT_FRONTEND_URL` from the n8n environment. Native templates fall back to the Mac app/common local URL `http://127.0.0.1:5620`; source-checkout dev should use the launcher/env value `http://127.0.0.1:5621`; Docker templates fall back to `http://app:3000`. The optional Docker n8n profile also sets `BATSHIT_FRONTEND_URL=http://app:3000` for the container.

For the optional Docker n8n profile, the n8n service itself is `http://n8n:5678` inside Docker. Your browser still opens n8n through its host-published URL, usually `http://localhost:5678` unless you changed `BATSHIT_DOCKER_N8N_PORT`.

## Import a Primary Agent template

1. Open n8n.
2. Import [`batshit-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-primary-agent.json). For the optional Docker n8n profile, use [`batshit-docker-n8n-primary-agent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-primary-agent.json).
3. Open the workflow and check the Webhook node.
4. Set the Webhook node Response Mode to `Streaming` and use a recognizable path, such as `batshit_n8n_primary`.
5. Configure the model/provider nodes with your n8n credentials.
6. Confirm the native AI Agent node has streaming, intermediate steps, and binary-image passthrough enabled.
7. Configure the `Batshit Tools` HTTP Request Tool.
8. Confirm it sends `x-batshit-native-tool-token` from `batshit_native_tool_token`.
9. Confirm it also sends the explicit `x-batshit-user-id` header expression where the template expects it.
10. Activate the workflow.
11. Copy the Production webhook URL from n8n.
12. In Batshit, create or edit a Primary Agent with type `n8n`.
13. Paste the n8n webhook URL into the agent's Webhook URL field.
14. Paste the n8n editor/workflow URL if you want Batshit to open the workflow sheet.
15. Send a small test message.

Provider API keys for n8n workflow nodes belong in n8n credentials. Batshit does not copy provider keys into n8n.

The streaming settings above are required for Batshit's n8n Primary contract, but native n8n may still buffer until the workflow response is ready before Batshit receives chunks to display. Tool details are hydrated from the finished n8n execution. This is expected for the launch `n8n` path.

## Import an n8n Workflow Subagent template

Use this template when an `API` or `CLI` Primary Agent should call a whole n8n workflow as a subagent.

1. Import [`batshit-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-workflow-subagent.json) into n8n. For the optional Docker n8n profile, use [`batshit-docker-n8n-workflow-subagent.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-workflow-subagent.json).
2. Configure model/provider credentials in n8n.
3. Configure the `Batshit Subagent Tools` HTTP Request Tool.
4. Confirm it sends `x-batshit-native-tool-token` from `batshit_native_tool_token`.
5. Activate the workflow.
6. Copy the Production webhook URL.
7. In Batshit, create a Subagent with type `n8n Workflow Subagent`.
8. Paste the webhook URL into that Subagent's settings.
9. Assign the Subagent to an `API` or `CLI` Primary Agent.
10. Test with a prompt that clearly asks the Primary Agent to call that Subagent.

Don't reuse a direct-chat `n8n` Primary Agent workflow as an n8n Workflow Subagent. Primary workflows and tool workflows have different roles.

## n8n Subnode Subagents

`n8n` Primary Agents use n8n Subnode Subagents when you explicitly wire them into the Primary workflow — AI Agent Tool nodes attached inside that workflow.

The default Primary template does not include a connected Subnode Subagent, which keeps unassigned subagents invisible to the model. When you intentionally assign a Subnode Subagent, copy the add-on nodes from [`batshit-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-subnode-subagent-addon.json) into the Primary workflow, or [`batshit-docker-n8n-subnode-subagent-addon.json`](/user-templates/batshit-official-n8n-workflow-templates/batshit-docker-n8n-subnode-subagent-addon.json) for the Docker profile. Connect the add-on's AI Agent Tool node to the Primary AI Agent, and update the slug/model/tool expressions to match the assigned subagent.

Use this shape when the Primary Agent is an `n8n` agent, you want the subagent to run inside the same workflow, and the n8n AI Agent Tool node can receive the prompt values Batshit sends in the webhook payload. Use an n8n Workflow Subagent instead when the parent is an `API` or `CLI` Primary Agent.

## Batshit Tools in n8n

The checked-in templates use a shared native automation pack through an HTTP Request Tool. This lets n8n agents call Batshit-managed capabilities without making each tool a separate n8n node. Common actions:

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
- `batshit_tool_use` with ref `fabric:sys.zip.fetch` for zip lookup (n8n Primary Agent runs only)

`batshit_tool_search` returns labeled results for discoverable MCP tools, saved CLI Tools, published Artifact runtime tools, and Agent Browser capabilities. `batshit_tool_use` should receive the exact result reference returned by search.

Subagent runs can't use Fetch Zip. If a subagent needs context from a large prior result, have the Primary Agent fetch or summarize it first.

Subagent tool scope is intentionally narrower than the parent Primary Agent. Subagents can use their assigned search/use families. Broad Fabric control-plane actions are not part of the n8n broker — the only `fabric:` ref exposed to n8n Primary Agents is `fabric:sys.zip.fetch` (Fetch Zip); n8n otherwise uses published Artifact runtime refs plus explicit `runtime_addon_*` actions.

Runtime add-on start/stop actions only work for approved add-ons and still require the configured host-side operator in Docker. They are not raw Docker access from n8n.

## Existing n8n vs the optional Docker n8n profile

Both paths are first-class.

**Existing n8n** is a good fit when you already run n8n with credentials/workflows there, you want n8n data to stay outside the Batshit Docker project, and you manage n8n updates yourself.

**The optional Docker n8n profile** is a good fit when you want a local n8n container next to Docker Batshit, you're comfortable importing templates and credentials into that opt-in instance, and you understand it still needs manual configuration.

The n8n profile uses port `5678` by default. If another n8n already uses that port, change `BATSHIT_DOCKER_N8N_PORT` or stop one of the instances. Browser cookies can collide across two n8n instances that both use `localhost`, so side-by-side testing may use `127.0.0.1` for one instance.

## Advanced CLI import

Normal users should import templates through the n8n UI.

If you operate n8n from the command line, the current official Primary Agent and Workflow Subagent templates include workflow-level IDs and have been validated with `n8n import:workflow` on n8n `2.22.1` in a clean disposable profile:

```sh
n8n import:workflow --input /path/to/template.json
```

After CLI import, still open the workflow in n8n, create credentials, check URLs, activate it, and test it from Batshit. Use UI import if you're unsure how your n8n instance handles repeat imports or workflow ID conflicts.

## Test checklist

Before calling a workflow ready:

- The workflow is active in n8n.
- The webhook Production URL is saved in the matching Batshit agent/subagent.
- n8n provider credentials are selected on the model nodes.
- Batshit Tools sends `x-batshit-native-tool-token` from the Batshit webhook payload.
- The Batshit Tools URL matches the caller.
- A simple chat message streams back to Batshit.
- A simple tool call renders in Batshit instead of only appearing in n8n logs.
- Execution Viewer in Batshit shows the run details you expect.
- Image messages are converted from Batshit image data URIs into n8n binary image fields by the Prepare node before they reach the AI Agent.

## Support boundaries

- Batshit backups do not silently include external n8n workflows or n8n credentials.
- Export n8n workflows from n8n separately if you need a full n8n backup.
- Don't import workflows from untrusted sources without reading them. n8n workflows can call external services, run code nodes, and handle secrets.
- Older template internals may contain compatibility field names. Leave those alone unless current Batshit release notes say they can be renamed.
