# Primary Agents

A Primary Agent is the AI you chat with directly in Batshit. It owns the conversation turn, decides when to answer or use tools, and can call Subagents you've assigned to it.

Batshit has two Primary Agent types:

| Type | What it means | Best when you want | Usually requires |
| --- | --- | --- | --- |
| `API` | Batshit talks directly to model providers through its built-in API path. | Fast setup, direct provider keys, Batshit-native tools, Group Chat, Voice, Artifacts, and strong all-around behavior. | Provider API keys or local provider connections saved in Batshit. |
| `CLI` | Batshit runs a managed CLI agent such as Codex or Claude Code inside the chat. | Code-heavy work, file edits, shell/search behavior, and CLI-native reasoning. | The CLI installed and authenticated where Batshit runs. |

These are peer choices, not quality tiers. Pick the path that matches the work: direct provider chat or a managed CLI agent.

n8n remains a first-class automation and tool platform. `API` and `CLI` Primary Agents can call n8n workflows as tools or as [n8n Workflow Subagents](../subagents/overview.md); n8n is not a Primary Agent type.

## Parallel chats

Batshit can keep more than one chat working at once. You can start a response in one session, switch to another, and keep working while the first finishes. Sessions that are still running show a small status in the chat sidebar.

`API` and `CLI` Primary Agents can run in parallel across sessions, up to three active chats at a time. When three are already running, Batshit asks you to stop or finish one before starting another.

## What stays the same

Whichever type you choose, the core workspace stays the same:

- Chat sessions and saved history.
- Projects and file references.
- Clips for reusable images and files.
- Zips for large outputs and tool results.
- Execution Viewer evidence.
- Artifacts and published Artifact tools.
- n8n workflow tools and n8n Workflow Subagents.
- Tool rendering, Voice, and Goons where the selected runtime supports them.

What changes is the path used to reach the model.

## `API` Primary Agents

An `API` Primary Agent uses Batshit's direct provider path. You save provider keys or local provider connections in Batshit, choose a model, and chat.

Batshit automatically makes API requests cache-friendly where the selected provider supports prompt/input caching. You do not need to hand-fill normal cache settings for everyday use: Batshit keeps the stable prompt/tool setup at the front of the request, adds provider-safe cache options for OpenAI, Anthropic, OpenRouter, and Vercel AI Gateway, and reads Gemini's implicit cache telemetry when Google reports it. Provider token minimums and time-to-live rules still apply, so short prompts may not show cache hits.

Use an `API` Primary Agent when:

- You want the simplest direct chat path.
- You want Batshit-native tools without running a coding CLI.
- You want Group Chat, Voice, or Goon behavior close to the chat runtime.
- You want n8n workflows to be callable tools or Workflow Subagents.
- You want to connect direct cloud providers or Local AI.

## `CLI` Primary Agents

A `CLI` Primary Agent lets Batshit host a managed CLI agent inside the chat. Batshit still owns the session, history, Clips, Zips, tool rendering, and UI; the CLI owns its provider-native command, search, and edit behavior.

Use a `CLI` Primary Agent when:

- The work is code-heavy.
- You want CLI-native project-file behavior.
- You want the agent to use its own command, edit, and search abilities.
- You want Batshit to keep the chat, Artifacts, Clips, Zips, and workspace around that CLI run.
- You want n8n workflow tools or Workflow Subagents available beside CLI-native work.

Docker note: a Docker install needs the CLI authenticated inside the app container. For Codex, Batshit shows the Docker-aware login command in Agent Settings. Provider keys saved in Batshit do not log the Codex CLI into the container.

## Choosing a Primary Agent

| If you mostly want... | Start with... |
| --- | --- |
| Direct AI chat with Batshit-native tools | `API` |
| Coding, shell, and repository work through a managed CLI agent | `CLI` |
| Group Chat | `API` or `CLI` |
| Existing n8n automations used as tools | `API` or `CLI` |
| An n8n workflow acting as a specialist | `API` or `CLI`, with an n8n Workflow Subagent |

You can create more than one. A common setup is one `API` agent for general work and one `CLI` agent for code.

## Setup checklist

For any Primary Agent:

1. Create or edit the agent in Settings.
2. Pick `API` or `CLI`.
3. Choose a model or runtime that's actually configured.
4. Add a clear description and system prompt.
5. Assign Projects, Subagents, Tools, Voice, and Goons only when you need them.
6. Send a tiny test message before giving the agent a large task.

For `API`:

1. Save provider keys or local provider connections in Settings.
2. Choose a model preset or provider/model pair.
3. Enable only the tools the agent should discover.

For `CLI`:

1. Make sure the CLI is installed in the same runtime where Batshit runs it.
2. Authenticate the CLI there.
3. In Docker, authenticate inside the `app` container, not just on the host.
4. Keep project paths visible from the runtime. Docker projects normally live under `/workspace`.

To add n8n:

1. Connect an existing n8n instance or start Batshit's optional Docker n8n profile.
2. Publish the workflows you want agents to call as tools, or import the official n8n Workflow Subagent template.
3. Create an `n8n Workflow Subagent` when the workflow should behave like a specialist assistant.
4. Assign the workflow tool or Subagent to the relevant `API` or `CLI` Primary Agent.

See [Connect n8n](connect-n8n.md) for exact setup and URL guidance.

## Mac app and Docker

Both are valid setup paths. Mac app Batshit is the richer local workstation path on macOS and integrates with host-local tools and runtimes naturally. Docker Batshit is more contained and reproducible, running the app, batshit-server, and Redis in one Compose stack; optional services like the Docker n8n profile, Agent Browser, LiveKit, Cloudflared, and runtime workers are explicit add-ons or connect-existing services.

If a URL works in your browser but fails from an agent, it's usually the wrong caller URL. [Ports and URLs](../reference/ports-and-urls.md) has the full caller table.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `API` agent says no model is configured | Provider key or model preset is missing. | Settings → API Keys and model settings. |
| `CLI` agent fails with auth errors | The CLI is installed but not logged in where Batshit runs it. | In Docker, run the login command inside the app container. |
| An n8n Workflow Subagent fails | Its production webhook, credentials, callback URL, or model node is wrong. | n8n execution history and [n8n troubleshooting](../troubleshooting/n8n.md). |
| Tools don't appear | Tool Grid discoverability is off, or the gateway is offline. | Agent Tools settings and MCP gateway health. |
| A Group can't use an agent | The agent record is missing, retired, or not a live `API`/`CLI` type. | Delete retired records and create an `API` or `CLI` agent. |

## Related docs

- [Connect n8n](connect-n8n.md)
- [Subagents](../subagents/overview.md)
- [Group Chat](../groups/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Projects and files](../projects/overview.md)
- [Security and trust](../security/overview.md)
