# Primary Agents

A Primary Agent is the AI you chat with directly in Batshit. It owns the conversation turn, decides when to answer or use tools, and can call Subagents you've assigned to it.

Batshit has two Primary Agent types: `API` and `CLI`.

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

### What a chat message lets the agent do

A Codex or Claude agent works in a mode. You pick it in the chat bar or in **Agent Settings**; both save it to the agent.

- **Codex:** Chat (read-only), Agent (workspace write), or Agent (full access). Each mode has its own **Sandbox Level**: Read-only, Workspace write, or Danger full access. Picking a mode also sets its own level.
- **Claude Code:** Plan, Ask before edits, Edit automatically, or Bypass permissions. Agent Settings offers all four; an older saved Ask-before-edits mode stays shown as that choice.

In Agent Settings, a Codex record with no saved Sandbox Level shows its mode's own level. **Agent (full access)** keeps the Sandbox Level control disabled. An older full-access record with a tighter saved level keeps that level; opening Settings or changing another field does not widen it. Pick **Agent** to adjust the Sandbox Level.

**What Agent Settings shows is the most the agent can do.** A message runs with the tighter of the chat bar's mode and what Agent Settings holds for that agent, never with more:

- If you set a tighter Sandbox Level by hand in Agent Settings (for example Agent with Read-only), a message uses that level. Open the chat bar's Codex mode menu to see it: the chosen mode has a second line, such as "Sandbox Level from Agent Settings: Read-only". Picking a mode in that menu sets the mode's own level again.
- A Sandbox Level that is looser than its mode (for example Chat with Workspace write) is not used by a chat message: Chat stays read-only.
- In a group chat, each member runs with its own mode, never with more than its own Agent Settings allow, whatever the sender's chat bar shows.
- A message that waits (in the chat's line, or behind a reply that is still running) uses the agent's settings as they are when its turn starts. If you make an agent tighter while a message waits, the tighter settings apply to it.
- If Agent Settings made a reply run tighter than the chat bar's mode (for example an older window still showed a looser mode), the reply says so in one line under it, such as "Codex ran as Chat, Read-only, because Agent Settings holds that for this agent; the chat bar sent Agent (full access)."

When you change the mode in the chat bar and send at once, Batshit waits for the change to save first, so the message runs with the mode you just picked. If the change could not be saved, the chat bar shows the earlier mode again and the message runs with that one. If an agent is deleted while a message for it waits, the message is not sent: it stays in the chat, unanswered.

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

## Saving Agent Settings

Agent Settings saves changes automatically. While a save for the shown agent is still on its way, its controls are temporarily read-only. You can select another agent while it finishes. A draft waiting to save, or a field that needs correcting, stays editable.

After 30 seconds without an answer, Settings shows a notice with **Retry**. Retry reads the saved record; it does not cancel the original save. Your draft stays visible, and choices that save several related values or a whole list wait for a successful read and for that agent’s pending writes to settle. If the read fails, use Retry; Settings keeps your draft.

## Changing an agent's picture

When you upload a new avatar picture, clear it, or choose an icon, the old picture is deleted once the change saves. If the change can't save (for example the name is empty), the old picture stays, so the agent never points at a picture that is gone.

A new agent can't use a name a Subagent already uses (their skill and artifact access would be shared); pick another name if Batshit says it is taken.

## Deleting an agent

Settings → Agents → the agent → **Delete Primary Agent**. This removes the agent and everything that is only its own: its settings, avatar pictures (the one it shows now and any you replaced earlier), memories, DMs sent to it, schedules, wake-up webhooks, and, for a `CLI` agent, the folders its Workers ran in under `~/.batshit/agents/` (they hold the CLI's own log of the Workers' prompts). It also drops the agent from any Group it was in, and from any skill or artifact list that named it.

The confirm dialog has an **Also delete its chats** box, checked by default. Leave it checked and the agent's own chats go with it, including its Infinite Session. Uncheck it to keep the chats. Two things never go: a Group chat (it belongs to every agent in the group; the agent is only removed from the roster), and a chat you locked yourself (unlock it first if you want it gone too; the dialog tells you how many are kept).

The avatar pictures are stored by batshit-server, so Batshit checks that batshit-server is running before it deletes anything, and asks it to delete the pictures before it deletes the agent. If batshit-server is not running, nothing is deleted, not even the chats, and the error says so. Restart Batshit (in Docker, run `./start-docker.sh`) and delete the agent again. If batshit-server stops partway through, the agent stays and the error says how many of its chats were already deleted.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `API` agent says no model is configured | Provider key or model preset is missing. | Settings → API Keys and model settings. |
| `CLI` agent fails with auth errors | The CLI is installed but not logged in where Batshit runs it. | In Docker, run the login command inside the app container. |
| An n8n Workflow Subagent fails | Its production webhook, credentials, callback URL, or model node is wrong. | n8n execution history and [n8n troubleshooting](../troubleshooting/n8n.md). |
| Tools don't appear | Tool Grid discoverability is off, or the gateway is offline. | Agent Tools settings and MCP gateway health. |
| A Group can't use an agent | The agent record is missing, retired, or not a live `API`/`CLI` type. | Delete retired records and create an `API` or `CLI` agent. |

## Letting an agent adjust its own preferences

A Primary Agent with the relevant Fabric Controls can read its own display name, Awareness/Triggers/Recalled Lane Budgets and the linger defaults for trigger and recalled memories. It can change that name and request your approval for those memory changes. It cannot use these actions to edit another agent, change access, expose credentials or prepare a provider. A newer edit blocks an older request. If another change conflicts with yours in Agent Settings, Batshit protects the newer saved values. Check the current setting and use **Retry** if Batshit still cannot save your edit. See [Fabric](../fabric/overview.md#asking-an-agent-to-use-the-current-view).

## Related docs

- [Connect n8n](connect-n8n.md)
- [Subagents](../subagents/overview.md)
- [Group Chat](../groups/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Projects and files](../projects/overview.md)
- [Security and trust](../security/overview.md)
