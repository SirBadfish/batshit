# Connect n8n

Batshit is built around n8n. You can use n8n as the runtime for a Primary Agent, or as a workflow/tool system that `API` and `CLI` agents call.

## The two main n8n uses

| Use | What it means | Batshit agent type |
| --- | --- | --- |
| n8n Primary Agent | The main chat agent runs inside a Batshit n8n workflow. | `n8n` |
| n8n workflow as tool or subagent | A direct Batshit agent calls an n8n workflow. | `API` or `CLI` |

Batshit has three Primary Agent types: `n8n`, `API`, and `CLI`. For subagents, `n8n Subnode Subagents` attach inside an n8n Primary Agent workflow, while `n8n Workflow Subagents` are separate workflows used by `API` and `CLI` Primary Agents.

## Choose existing or the optional Docker n8n profile

| Option | Good fit |
| --- | --- |
| Existing n8n | You already run n8n and want Batshit to connect to it. |
| Optional Docker n8n profile | You want Batshit Docker Compose to run a local n8n for this instance. |
| Local n8n | You run Mac app or source-checkout Batshit and a normal host n8n on the same machine. |

The Docker n8n profile is opt-in. Existing self-hosted n8n is first-class.

## Required n8n pieces

An n8n Primary Agent needs:

- An imported Batshit Primary Agent workflow template.
- The official Batshit Tools node, which forwards Batshit's per-message native-tool token as `x-batshit-native-tool-token`.
- Provider credentials in n8n.
- A model/provider node configuration in n8n.
- A production webhook URL pasted into the matching Batshit agent.
- The workflow activated in n8n.

The default Primary Agent response stream uses n8n's native Webhook streaming response.

The official template source lives at:

```text
docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/
```

Main template files:

- `batshit-n8n-primary-agent.json`
- `batshit-n8n-workflow-subagent.json`
- `batshit-n8n-subnode-subagent-addon.json`
- `batshit-docker-n8n-primary-agent.json`
- `batshit-docker-n8n-workflow-subagent.json`
- `batshit-docker-n8n-subnode-subagent-addon.json`

## Optional Docker n8n profile

If you start Docker Batshit with:

```sh
./start-docker.sh --profile n8n
```

the n8n profile starts an official pinned n8n image by default. You still need to open n8n, create credentials, import templates, configure provider nodes, and activate workflows.

## Existing self-hosted n8n

For existing self-hosted n8n, import the official templates, then configure credentials, provider nodes, and webhook URLs for that n8n instance.

## Native tool auth

Current official n8n agent templates don't need a saved Header Auth credential for Batshit Tools. Batshit sends each n8n chat request a short-lived, per-message native-tool token, and the workflow forwards it with this dynamic header:

| Header name | Header value expression |
| --- | --- |
| `x-batshit-native-tool-token` | `{{$json.body.batshit_native_tool_token}}` |

## Create provider credentials in n8n

Provider credentials for n8n workflows belong in n8n — for example an OpenAI, Anthropic, OpenRouter, or Vercel AI Gateway credential. Batshit Settings → API Keys does not copy provider keys into n8n.

## Configure Redis memory if the template uses it

The official template can use Redis-backed memory. Use a Redis host the n8n process can reach:

| n8n location | Redis host guidance |
| --- | --- |
| Local n8n on the same host as Mac app Batshit | `localhost`, port `5639` |
| Local n8n on the same host as source-checkout Batshit | `localhost`, port `6379` |
| Optional Docker n8n profile | `redis`, port `6379` |
| Existing host n8n connected to Docker Batshit | A Redis reachable from that host n8n, or adjust the workflow memory path intentionally |

Docker Batshit's Redis is internal-only by default. Don't assume an external host n8n can reach the Docker `redis` service unless you deliberately expose or route it.

## Import the Primary Agent template

In n8n:

1. Open Workflows.
2. Import from file.
3. Choose `batshit-n8n-primary-agent.json`.
4. Configure missing credentials.
5. Confirm each Batshit Tools HTTP Request Tool URL matches the n8n caller. The official templates prefer the Batshit URL sent in the webhook payload, then `BATSHIT_FRONTEND_URL` from the n8n environment, then `http://127.0.0.1:5620` for Mac app local server-to-server calls. Source-checkout dev should receive or set `http://127.0.0.1:5621` through the launcher/env path.
6. Configure provider/model nodes.
7. Save.
8. Activate the workflow.
9. Copy the Production webhook URL.

Use the production webhook URL, not a temporary test URL.

## URL rules

Most n8n headaches are URL problems. Use the URL from the point of view of the service making the request.

### Mac app Batshit and local n8n

| Purpose | URL |
| --- | --- |
| Batshit app browser companion | `http://127.0.0.1:5620` |
| n8n browser/editor | `http://localhost:5678` |
| Batshit native tool dispatch from n8n | `http://127.0.0.1:5620/api/native-tools/dispatch` |
| batshit-server | `http://localhost:5600` |

Prefer `127.0.0.1` for Mac app Batshit URLs, including the browser companion window and local n8n server-to-server calls. This avoids collisions with source-checkout/development runtimes, and cases where Node/n8n resolves `localhost` to IPv6 `::1` while the packaged Mac app listens on IPv4 loopback.

### Source-checkout Batshit and local n8n

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5621` |
| Browser opens n8n | `http://localhost:5678` |
| Host n8n calls source-checkout Batshit | `http://127.0.0.1:5621` |

Source-checkout Batshit binds its Vite dev server to IPv4 loopback by default so local n8n can call `http://127.0.0.1:5621/api/native-tools/dispatch`. The source-checkout default is intentionally offset from the Mac app's `127.0.0.1:5620` user-like lane. If you override `BATSHIT_FRONTEND_HOST` to IPv6 or another host, also set `N8N_BATSHIT_FRONTEND_URL` to a URL n8n can actually reach.

### Optional Docker n8n profile

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5620` |
| Browser opens n8n | `http://localhost:5678` |
| n8n container calls Batshit app | `http://app:3000` |
| n8n container calls native tool dispatch | `http://app:3000/api/native-tools/dispatch` |
| App container calls n8n API | `http://n8n:5678` |

Batshit's Docker n8n profile sets `BATSHIT_FRONTEND_URL=http://app:3000`, so the official templates can call the app through the Compose network after import. For the app container to call the n8n profile server-side, `.env.docker` must use `N8N_API_URL=http://n8n:5678`. Keep `N8N_EDITOR_BASE_URL`, `WEBHOOK_URL`, and `N8N_WEBHOOK_URL` browser-facing.

### Docker Batshit with existing host n8n

| Purpose | URL |
| --- | --- |
| Browser opens Batshit | `http://localhost:5620` |
| Browser opens n8n | `http://localhost:5678` |
| App container calls host n8n | `http://host.docker.internal:5678` |
| Host n8n calls Docker-published Batshit app | `http://127.0.0.1:5620` |

If your n8n runs in a separate container stack, use the URL reachable from that container.

## Connect the workflow in Batshit

1. Open Settings → Agents.
2. Create or edit a Primary Agent.
3. Set the agent type to `n8n`.
4. Paste the n8n production webhook URL.
5. Paste the n8n workflow/editor URL if you want the workflow sheet link.
6. Save.
7. Select the agent in chat.
8. Send a simple message.

If the workflow runs in n8n but Batshit doesn't show the streamed response, check that the Webhook node Response Mode is `Streaming`, the native AI Agent node has streaming enabled, the agent uses the Production webhook URL, and n8n can reach Batshit at the saved URL.

## n8n Workflow Subagents

Use `batshit-n8n-workflow-subagent.json` when an `API` or `CLI` Primary Agent should call an n8n workflow as a subagent. In Batshit, create a Subagent with the `n8n Workflow Subagent` type, paste its webhook URL, and assign it to an `API` or `CLI` Primary Agent.

Don't use an n8n Primary Agent workflow as an n8n Workflow Subagent — Primary workflows and tool/subagent workflows have different contracts.

## Optional n8n API key in Batshit

Batshit can store an n8n API key in Settings → API Keys for Batshit-side n8n API integrations: workflow discovery, Execution Viewer hydration, and stopping a running n8n execution when you press Stop in chat. This is optional for basic webhook chat.

For the full native `n8n` Primary experience, create an n8n API key with these scopes when your instance offers scoped keys:

- `execution:list`
- `execution:read`
- `execution:stop`
- `workflow:list`
- `workflow:read`

Without `execution:stop`, Batshit can stop the visible response stream, but n8n may keep running the workflow until it finishes naturally. Provider credentials still stay in n8n.

## Troubleshooting

### Workflow doesn't appear in Batshit

Check that the workflow is active, you pasted the production webhook URL, the Batshit agent type is `n8n`, and the workflow was imported from the native official Primary template.

### n8n returns auth errors to Batshit

Check that the workflow was imported from the current official template, the Batshit Tools node sends `x-batshit-native-tool-token`, and the header value reads `batshit_native_tool_token` from the webhook payload.

### Docker URL works in browser but fails in workflow

Check who's calling: browsers use `localhost`, Docker containers use service names like `app`, `batshit-server`, and `n8n`, and the Docker app calling host services uses `host.docker.internal`.

### Provider credential missing

Create the provider credential in n8n. Batshit API Keys don't appear inside n8n automatically.

### Imported workflow has stale credential IDs

Use the sanitized Batshit templates when possible. Raw exports from another n8n instance can carry source credential IDs, owner metadata, and old local URLs.

Next: [Backup and restore](../admin/backup-and-restore.md)
