# Connect n8n

Batshit is built to work with n8n as an automation and tool platform. `API` and `CLI` Primary Agents can call n8n workflows as ordinary tools or as specialist n8n Workflow Subagents.

## The two n8n uses

| Use | What it means | Batshit setup |
| --- | --- | --- |
| n8n workflow tool | A Primary Agent calls a published workflow for a focused action. | Add the workflow through Batshit's n8n/MCP tooling and enable it for the agent. |
| n8n Workflow Subagent | A Primary Agent delegates a task to a separate workflow that has its own model, prompt, and tools. | Create an `n8n Workflow Subagent`, paste its production webhook URL, and assign it to an `API` or `CLI` Primary Agent. |

n8n is not a Primary Agent type. Batshit Primary Agents are `API` and `CLI`.

## Choose existing or the optional Docker n8n profile

| Option | Good fit |
| --- | --- |
| Existing n8n | You already run n8n and want Batshit to connect to it. |
| Optional Docker n8n profile | You want Batshit Docker Compose to run a local n8n for this instance. |
| Local n8n | You run Mac app or source-checkout Batshit and a normal host n8n on the same machine. |

The Docker n8n profile is opt-in. Existing self-hosted n8n is first-class.

## Official Workflow Subagent templates

The official template source lives at:

```text
docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/
```

The supported templates are:

- `batshit-n8n-workflow-subagent.json`
- `batshit-docker-n8n-workflow-subagent.json`

Use the first template for a host/local n8n instance. Use the Docker version when n8n runs in Batshit's optional Docker profile.

## What an n8n Workflow Subagent needs

- The matching official Workflow Subagent template imported into n8n.
- Provider credentials and a model node configured in n8n.
- A production webhook URL pasted into the Batshit Subagent.
- The workflow activated in n8n.
- The official Batshit Subagent Tools HTTP Request Tool node if the workflow needs Batshit tools.
- A parent `API` or `CLI` Primary Agent assignment.

## Native tool authentication

Current official Workflow Subagent templates do not need a saved Batshit Header Auth credential. Batshit sends a short-lived, per-message native-tool token in the webhook payload, and the workflow forwards it with this dynamic header:

| Header name | Header value expression |
| --- | --- |
| `x-batshit-native-tool-token` | `{{$json.body.batshit_native_tool_token}}` |

The workflow also forwards the parent agent ID, Subagent ID, session ID, message ID, and the caller's Primary Agent type. Those fields keep tool permissions scoped to the exact parent/Subagent call.

## Create provider credentials in n8n

Provider credentials for n8n workflows belong in n8n—for example an OpenAI, Anthropic, OpenRouter, or Vercel AI Gateway credential. Batshit Settings → API Keys does not copy provider keys into n8n.

## Configure Redis memory if the template uses it

Use a Redis host the n8n process can reach:

| n8n location | Redis host guidance |
| --- | --- |
| Local n8n on the same host as Mac app Batshit | `localhost`, port `5639` |
| Local n8n on the same host as source-checkout Batshit | `localhost`, port `6379` |
| Optional Docker n8n profile | `redis`, port `6379` |
| Existing host n8n connected to Docker Batshit | A Redis reachable from that host n8n, or adjust the workflow memory path intentionally |

Docker Batshit's Redis is internal-only by default. Do not assume an external host n8n can reach the Docker `redis` service unless you deliberately expose or route it.

## Import the Workflow Subagent template

In n8n:

1. Open Workflows.
2. Import from file.
3. Choose `batshit-n8n-workflow-subagent.json`, or the Docker version for the optional Docker n8n profile.
4. Configure missing provider and Redis credentials.
5. Confirm the Batshit Subagent Tools URL matches the caller. The template prefers the Batshit URL sent in the webhook payload, then `BATSHIT_FRONTEND_URL` from the n8n environment, then `http://127.0.0.1:5620`.
6. Configure the model node.
7. Save and activate the workflow.
8. Copy the Production webhook URL.

Use the production webhook URL, not a temporary test URL.

## URL rules

Use the URL from the point of view of the service making the request.

### Mac app Batshit and local n8n

| Purpose | URL |
| --- | --- |
| Batshit app | `http://127.0.0.1:5620` |
| n8n browser/editor | `http://localhost:5678` |
| n8n calls Batshit native tool dispatch | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| batshit-server | `http://localhost:5600` |

Prefer `127.0.0.1` for Mac app server-to-server calls. This avoids cases where Node/n8n resolves `localhost` to IPv6 while the packaged app listens on IPv4 loopback.

### Source-checkout Batshit and local n8n

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5621` |
| Browser opens n8n | `http://localhost:5678` |
| Host n8n calls source-checkout Batshit | `http://127.0.0.1:5621` |

If you override `BATSHIT_FRONTEND_HOST`, also set `N8N_BATSHIT_FRONTEND_URL` to a URL n8n can actually reach.

### Optional Docker n8n profile

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5620` |
| Browser opens n8n | `http://localhost:5678` |
| n8n container calls Batshit app | `http://app:3000` |
| n8n container calls native tool dispatch | `http://app:3000/api/native-tools/dispatch` |
| App container calls n8n API | `http://n8n:5678` |

Batshit's Docker n8n profile sets `BATSHIT_FRONTEND_URL=http://app:3000`. Keep `N8N_EDITOR_BASE_URL`, `WEBHOOK_URL`, and `N8N_WEBHOOK_URL` browser-facing.

### Docker Batshit with existing host n8n

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5620` |
| Browser opens n8n | `http://localhost:5678` |
| App container calls host n8n | `http://host.docker.internal:5678` |
| Host n8n calls Docker-published Batshit app | `http://127.0.0.1:5620` |

If your n8n runs in a separate container stack, use the URL reachable from that container.

## Connect the Workflow Subagent in Batshit

1. Open Settings → Agents.
2. Create a Subagent.
3. Choose `n8n Workflow Subagent`.
4. Paste the production webhook URL.
5. Choose the model preset that represents the workflow's model node.
6. Save the Subagent.
7. Assign it to an `API` or `CLI` Primary Agent.
8. Ask the Primary Agent to delegate a small test task.

Saving an n8n Workflow Subagent refreshes Batshit's local n8n parameter-compatibility snapshot. Opening its model card refreshes a stale snapshot at most once per day, and the model card has a manual refresh button. A sync failure appears on that surface; it does not silently hide the problem.

## Use n8n workflows as tools

Use a workflow tool when the operation has a clear input/output contract and does not need a separate specialist conversation. Publish the workflow through your configured n8n/MCP integration, enable it in the Primary Agent's Tool Grid, and use Batshit Tool Search/Use to discover it on demand.

Use an n8n Workflow Subagent when the workflow should have its own system prompt, model, memory, or collection of tools.

## Optional n8n API key in Batshit

Batshit can store an n8n API key in Settings → API Keys for workflow discovery, model-node compatibility refresh, and other Batshit-side n8n API integrations. This key is separate from provider credentials stored inside n8n.

## Troubleshooting

### Workflow Subagent does not answer

Check that the workflow is active, the Batshit Subagent uses the Production webhook URL, the workflow was imported from the current Workflow Subagent template, and its provider/model credentials work.

### Batshit Subagent Tools returns an authentication error

Check that the node sends `x-batshit-native-tool-token`, the value reads `batshit_native_tool_token` from the webhook payload, and the template still forwards `parent_agent_id`.

### Docker URL works in a browser but fails in the workflow

Check who is calling: browsers use `localhost`, Docker containers use service names like `app`, `batshit-server`, and `n8n`, and the Docker app calling host services uses `host.docker.internal`.

### Provider credential is missing

Create the provider credential in n8n. Batshit API Keys do not appear inside n8n automatically.

### Imported workflow has stale credential IDs

Use the sanitized Batshit templates when possible. Raw exports from another n8n instance can carry source credential IDs, owner metadata, and old local URLs.

Next: [n8n workflow templates](../resources/n8n-workflow-templates.md)
