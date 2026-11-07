# Connect n8n

Batshit is built to work with n8n as an automation and tool platform. Primary Agents can call your n8n workflows as ordinary tools, and an n8n workflow can call Batshit to wake an agent.

n8n is not a kind of agent. Primary Agents and Subagents run on the saved model you pick. A saved n8n Workflow Subagent no longer runs or appears in Settings, and Batshit does not convert it. Your n8n workflows themselves are untouched. Publish one as a tool, or recreate the specialist as a [Subagent](../subagents/overview.md).

## The two n8n uses

| Use | What it means | Batshit setup |
| --- | --- | --- |
| n8n workflow tool | A Primary Agent calls a published workflow for a focused action. | Add the workflow through Batshit's n8n/MCP tooling and enable it for the agent. |
| n8n wakes a Batshit agent | A workflow calls Batshit and starts a chat for one agent when something happens outside Batshit. | Create a [wake-up webhook](agent-dms-and-wake-ups.md#wake-up-webhooks), then use the official wake-up template or your own HTTP Request node. |

## Choose existing or the optional Docker n8n profile

| Option | Good fit |
| --- | --- |
| Existing n8n | You already run n8n and want Batshit to connect to it. |
| Optional Docker n8n profile | You want Batshit Docker Compose to run a local n8n for this instance. |
| Local n8n | You run Mac app or source-checkout Batshit and a normal host n8n on the same machine. |

The Docker n8n profile is opt-in. Existing self-hosted n8n is first-class.

## Official template

The official template source lives at:

```text
docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/
```

It holds one template, `batshit-n8n-wake-agent-on-schedule.json`, which has n8n wake a Batshit agent on a timer. [Templates](../reference/templates.md#wake-an-agent-on-a-schedule-with-n8n) explains how to set it up. For a trigger that is only time, Batshit's built-in Schedules need no n8n at all.

## Create provider credentials in n8n

Provider credentials for n8n workflows belong in n8n, for example an OpenAI, Anthropic, OpenRouter, or Vercel AI Gateway credential. Batshit Settings → API Keys does not copy provider keys into n8n.

## URL rules

Use the URL from the point of view of the service making the request.

### Mac app Batshit and local n8n

| Purpose | URL |
| --- | --- |
| Batshit app | `http://127.0.0.1:5620` |
| n8n browser/editor | `http://localhost:5678` |
| n8n calls a Batshit wake-up webhook | `http://127.0.0.1:5620/api/wake/<webhook id>` |
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
| n8n container calls a wake-up webhook | `http://app:3000/api/wake/<webhook id>` |
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

## Use n8n workflows as tools

Use a workflow tool when the operation has a clear input/output contract. Publish the workflow through your configured n8n/MCP integration, enable it in the Primary Agent's Tool Grid, and use Batshit Tool Search/Use to discover it on demand.

If you want a specialist with its own system prompt, model, memory, or collection of tools, create a Subagent instead. See [Subagents](../subagents/overview.md).

## Optional n8n API key in Batshit

Batshit can store an n8n API key in Settings → API Keys for workflow discovery and other Batshit-side n8n API integrations. This key is separate from provider credentials stored inside n8n.

## Troubleshooting

### Docker URL works in a browser but fails in the workflow

Check who is calling: browsers use `localhost`, Docker containers use service names like `app`, `batshit-server`, and `n8n`, and the Docker app calling host services uses `host.docker.internal`.

### Provider credential is missing

Create the provider credential in n8n. Batshit API Keys do not appear inside n8n automatically.

### Imported workflow has stale credential IDs

Use the sanitized Batshit templates when possible. Raw exports from another n8n instance can carry source credential IDs, owner metadata, and old local URLs.

Next: [Templates](../reference/templates.md)
