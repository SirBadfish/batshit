# Primary Agents

A Primary Agent is the AI you chat with directly in Batshit. It owns the conversation turn, decides when to answer, decides when to use tools, and can call Subagents you've assigned to it.

Batshit has three launch-facing Primary Agent types:

| Type | What it means | Best when you want | Usually requires |
| --- | --- | --- | --- |
| `n8n` | An n8n workflow is the AI agent. Batshit is the friendly chat/workspace front end for it. | Visual automation, n8n credentials and nodes, and workflow-first control. | n8n running, a Batshit n8n Primary Agent workflow, and a webhook URL. |
| `API` | Batshit talks directly to model providers through its built-in API path. | Fast setup, direct provider keys, Batshit-native tools, Group Chat, Voice, Artifacts, and strong all-around behavior. | Provider API keys or local provider connections saved in Batshit. |
| `CLI` | Batshit runs a managed CLI agent such as Codex or Claude Code inside the chat. | Code-heavy work, file edits, shell/search behavior, and CLI-native reasoning. | The CLI installed and authenticated where Batshit runs. |

These are peer choices, not quality tiers. The right one depends on where you want the AI work to happen: inside n8n, directly through Batshit, or through a CLI agent.

## Parallel chats

Batshit can keep more than one chat working at once. You can start a response in one session, switch to another, and keep working while the first finishes. Sessions that are still running show a small status in the chat sidebar.

`API` and `CLI` Primary Agents can run in parallel across sessions, up to three active chats at a time. When three are already running, Batshit asks you to stop or finish one before starting another.

`n8n` Primary Agents run by themselves. If any chat is already active, Batshit asks you to finish it before starting an n8n chat — and if an n8n chat is active, Batshit asks you to wait before starting another.

## What stays the same

Whichever type you choose, the core workspace stays the same:

- Chat sessions and saved history.
- Projects and file references.
- Clips for reusable images and files.
- Zips for large outputs and tool results.
- Execution Viewer evidence.
- Artifacts.
- Tool rendering.
- Model and provider settings, where that type supports them.
- Goon and Voice integration, where the selected runtime supports it.

What changes is the path used to reach the AI and tools.

## `n8n` Primary Agents

An `n8n` Primary Agent uses a real n8n workflow as the main assistant. The standard launch template is a workflow with a Webhook node, n8n's native AI Agent node, and a Batshit Tools HTTP Request Tool node wired in as the agent's tool bridge. You chat in Batshit, Batshit sends your message to the n8n webhook, and n8n streams the answer back.

Use an `n8n` Primary Agent when:

- You already think in n8n workflows.
- You want provider credentials, model nodes, and workflow logic to live in n8n.
- You want the AI to call n8n-native tools and branches.
- You want visual workflow debugging in n8n execution history.

A few things to know:

- n8n's editor usually runs at `http://localhost:5678`.
- If n8n isn't running or reachable, n8n Primary Agents stay visible in Batshit's selectors but are disabled until n8n is connected again.
- Batshit never copies provider API keys into n8n. n8n workflow credentials belong in n8n.
- Existing n8n and the optional Docker n8n profile are both first-class. Neither replaces the other.

For the exact URLs to use from each caller, see [Ports and URLs](../reference/ports-and-urls.md).

## `API` Primary Agents

An `API` Primary Agent uses Batshit's direct provider path. You save provider keys or local provider connections in Batshit, choose a model, and chat — no Primary Agent workflow in n8n required.

Batshit automatically makes `API` agent requests cache-friendly where the selected provider supports prompt/input caching. You do not need to hand-fill normal cache settings for everyday use: Batshit keeps the stable prompt/tool setup at the front of the request, adds provider-safe cache options for OpenAI, Anthropic, OpenRouter, and Vercel AI Gateway, and reads Gemini's implicit cache telemetry when Google reports it. Provider token minimums and TTL rules still apply, so short prompts may not show cache hits.

Use an `API` Primary Agent when:

- You want the simplest direct chat path.
- You want Batshit-native tools without first building an n8n workflow.
- You want Group Chat. (Group Chat is launch-supported for `API` and `CLI`, not `n8n`.)
- You want Batshit Voice and Goon behavior close to the chat runtime.
- You want n8n workflows to be tools rather than the main assistant.

An `API` Primary Agent can still use n8n — the difference is that n8n workflows become callable tools instead of the conversation runtime.

## `CLI` Primary Agents

A `CLI` Primary Agent lets Batshit host a managed CLI agent inside the chat. Batshit still owns the session, history, Clips, Zips, tool rendering, and UI; the CLI owns its provider-native command, search, and edit behavior.

Use a `CLI` Primary Agent when:

- The work is code-heavy.
- You want CLI-native project-file behavior.
- You want the agent to use its own command, edit, and search abilities.
- You want Batshit to keep the chat, Artifacts, Clips, Zips, and workspace around that CLI run.

Docker note: a Docker install needs the CLI authenticated inside the app container. For Codex, Batshit shows the Docker-aware login command in Agent Settings. Provider keys saved in Batshit do not log the Codex CLI into the container.

## Choosing a Primary Agent

Start with the runtime that matches your mental model:

| If you mostly want... | Start with... |
| --- | --- |
| A visual workflow as the assistant brain | `n8n` |
| Direct AI chat with Batshit-native tools | `API` |
| Coding, shell, and repo work through a managed CLI agent | `CLI` |
| Group Chat | `API` or `CLI` |
| Existing n8n automations used as tools | `API` or `CLI` |
| n8n as the main assistant | `n8n` |

You can create more than one. A common setup is one `API` agent for general work, one `CLI` agent for code, and one `n8n` agent for workflow-first automation.

## Setup checklist

For any Primary Agent:

1. Create or edit the agent in Settings.
2. Pick the Primary Agent type.
3. Choose a model or runtime that's actually configured.
4. Add a clear description and system prompt.
5. Assign Projects, Subagents, Tools, Voice, and Goons only when you need them.
6. Send a tiny test message before giving the agent a large task.

For `n8n`:

1. Import or build the Batshit n8n Primary Agent workflow in n8n.
2. Create the provider credentials in n8n.
3. Configure the model/provider nodes in n8n.
4. Copy the browser-facing webhook URL into the Batshit agent.
5. Copy the n8n editor URL if you want Batshit to link back to the workflow.

The current official Batshit Tools nodes do not need a saved Batshit Header Auth credential. Batshit sends each n8n chat request a short-lived native-tool token, and the workflow forwards it as `x-batshit-native-tool-token`.

For `API`:

1. Save provider keys or local provider connections in Settings.
2. Choose a model preset or provider/model pair.
3. Enable only the tools the agent should discover.

For `CLI`:

1. Make sure the CLI is installed in the same runtime where Batshit runs it.
2. Authenticate the CLI there.
3. In Docker, authenticate inside the `app` container, not just on the host.
4. Keep project paths visible from the runtime. Docker projects normally live under `/workspace`.

## Mac app and Docker

Both are valid setup paths. Mac app Batshit is the richer local workstation path on macOS — it integrates with host-local tools and runtimes more naturally because Batshit already runs on the host. Docker Batshit is more contained and reproducible, running the app, batshit-server, and Redis in one Compose stack; optional services like the Docker n8n profile, Agent Browser, LiveKit, Cloudflared, and runtime workers are explicit add-ons or connect-existing services.

If a URL works in your browser but fails from an agent, it's usually the wrong caller URL. [Ports and URLs](../reference/ports-and-urls.md) has the full caller table.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `n8n` agent never answers | Webhook URL, n8n credentials, Webhook streaming, callback URL, or model-node mismatch. | n8n execution history, the Webhook Production URL, native AI Agent streaming, and the `x-batshit-native-tool-token` header on Batshit Tools nodes. |
| `API` agent says no model is configured | Provider key or model preset is missing. | Settings → API Keys and model settings. |
| `CLI` agent fails with auth errors | The CLI is installed but not logged in where Batshit runs it. | In Docker, run the login command inside the app container. |
| Tools don't appear | Tool Grid discoverability is off, or the gateway is offline. | Agent Tools settings and MCP gateway health. |
| A Group can't use an agent | Group Chat is launch-supported for `API` and `CLI`. | Use an `API` or `CLI` Primary Agent for groups. |

## Related docs

- [Subagents](../subagents/overview.md)
- [Group Chat](../groups/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Projects and files](../projects/overview.md)
- [Security and trust](../security/overview.md)
