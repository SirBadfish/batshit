# Primary Agents

A Primary Agent is the AI you chat with directly in Batshit. It owns the conversation turn, decides when to answer or use tools, and can call Subagents you've assigned to it.

Every Primary Agent works the same way: Batshit runs it, with Batshit's tools and features, on the saved model you pick. The model's connection decides how it reaches the model and how it pays: an API key, a Local AI runtime, your ChatGPT plan or your Claude plan.

For Claude models on your own Claude plan, pick a model on the [Claude plan](../providers/claude-plan.md) connection. Claude Code then acts only as the model, and Batshit runs every tool.

## Parallel chats

Batshit can keep more than one chat working at once. You can start a response in one session, switch to another, and keep working while the first finishes. Sessions that are still running show a small status in the chat sidebar.

Primary Agents can run in parallel across sessions, up to three active chats at a time. When three are already running, Batshit asks you to stop or finish one before starting another.

## What stays the same

Whichever model you choose, the core workspace stays the same:

- Chat sessions and saved history.
- Projects and file references.
- Clips for reusable images and files.
- Zips for large outputs and tool results.
- Execution Viewer evidence.
- Artifacts and published Artifact tools.
- n8n workflow tools.
- Tool rendering, Voice, and Goons where the selected runtime supports them.

What changes is the path used to reach the model.

## How a Primary Agent reaches its model

A Primary Agent uses Batshit's own path to its model's connection. You save provider keys, local provider connections or a plan connection in Batshit, choose a saved model, and chat.

Batshit automatically makes API requests cache-friendly where the selected provider supports prompt/input caching. You do not need to hand-fill normal cache settings for everyday use: Batshit keeps the stable prompt/tool setup at the front of the request, adds provider-safe cache options for OpenAI, Anthropic, OpenRouter, and Vercel AI Gateway, and reads Gemini's implicit cache telemetry when Google reports it. Provider token minimums and time-to-live rules still apply, so short prompts may not show cache hits.


## What a chat message lets the agent do

An agent works in the Work mode you pick in the chat bar or in **Agent Settings**: Plan, Agent, or Dangerous (shown as **Batshit Crazy**). Both places save the same setting to the agent. [Bash access modes](../tools/overview.md#bash-access-modes) says what each mode allows.

- In a group chat, each member runs with its own saved mode.
- A message that waits (in the chat's line, or behind a reply that is still running) uses the agent's settings as they are when its turn starts. If you make an agent tighter while a message waits, the tighter settings apply to it.
- If an agent is deleted while a message for it waits, the message is not sent: it stays in the chat, unanswered.

## Claude Code CLI agents were removed

Batshit no longer runs a Primary Agent on the Claude Code CLI lane, where Claude Code ran the whole agent with its own tools and loop. If you still have such an agent, it stays in your list, but it won't run: a message to it, a schedule, a wake-up or a DM says "The Claude Code CLI lane was removed from Batshit." It never quietly turns into another kind of agent. Its Agent Settings show a short notice, they can't be saved, and the agent can't join a Group. Deleting it is the only thing you can do with it (see [Deleting an agent](#deleting-an-agent)).

To keep working with Claude, create a new agent and pick a Claude plan model. Batshit's own tools, Work modes, approval cards, Sandbox and lists then apply to everything it does. Claude Code's own Web Search, Web Fetch and Chrome switches went with the old lane: use Batshit's Web Search tool, Agent Browser for browsing, and Workers for helpers that run side by side.

Claude Code CLI Subagents were removed too. For a Claude helper, make an ordinary Subagent on a Claude plan model; see [Subagents](../subagents/overview.md).

## Choosing a Primary Agent

Create a Primary Agent and pick its saved model. Create more than one when you want different models, connections, prompts or tools; each agent keeps its own settings.

## Setup checklist

For any Primary Agent:

1. Create or edit the agent in Settings.
2. Choose a saved model whose connection is set up.
3. Add a clear description and system prompt.
4. Assign Projects, Subagents, Tools, Voice, and Goons only when you need them.
5. Send a tiny test message before giving the agent a large task.

For a provider key or Local AI:

1. Save provider keys or local provider connections in Settings.
2. Choose a model preset or provider/model pair.
3. Enable only the tools the agent should discover.

For your Claude plan:

1. Open Settings → API Keys → Claude Plan. Install Claude Code from the card if needed, and sign in with your Claude plan until the card says **Ready**.
2. Make a model preset on the **Claude Plan** connection and pick it for the agent. See [Claude plan](../providers/claude-plan.md).

To add n8n:

1. Connect an existing n8n instance or start Batshit's optional Docker n8n profile.
2. Publish the workflows you want agents to call as tools.
3. Enable the workflow tool for the Primary Agent that should use it.

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

Settings → Agents → the agent → **Delete Primary Agent**. This removes the agent and everything that is only its own: its settings, avatar pictures (the one it shows now and any you replaced earlier), memories, DMs sent to it, schedules, wake-up webhooks, and any Claude Code folders the removed CLI lanes left for it under `~/.batshit/agents/` (they hold the CLI's own log of those prompts). It also drops the agent from any Group it was in, and from any skill or artifact list that named it.

The confirm dialog has an **Also delete its chats** box, checked by default. Leave it checked and the agent's own chats go with it, including its Infinite Session. Uncheck it to keep the chats. Two things never go: a Group chat (it belongs to every agent in the group; the agent is only removed from the roster), and a chat you locked yourself (unlock it first if you want it gone too; the dialog tells you how many are kept).

The avatar pictures are stored by batshit-server, so Batshit checks that batshit-server is running before it deletes anything, and asks it to delete the pictures before it deletes the agent. If batshit-server is not running, nothing is deleted, not even the chats, and the error says so. Restart Batshit (in Docker, run `./start-docker.sh`) and delete the agent again. If batshit-server stops partway through, the agent stays and the error says how many of its chats were already deleted.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| An agent says no model is configured | Provider key or model preset is missing. | Settings → API Keys and model settings. |
| An agent on the Claude plan is not signed in | Claude Code needs your plan sign-in. | Settings → API Keys → Claude Plan. |
| An agent says its CLI lane was removed | It is a leftover agent of a removed type. | Copy anything you need, delete it and create a new agent on a saved model. |
| An n8n workflow tool fails | Its production webhook, credentials, or model node is wrong. | n8n execution history and [n8n troubleshooting](../troubleshooting/n8n.md). |
| Tools don't appear | Tool Grid discoverability is off, or the gateway is offline. | Agent Tools settings and MCP gateway health. |
| A Group cannot use an agent | The saved record is missing or is a leftover of a removed type. | Delete the leftover and create a new agent. |

## Letting an agent adjust its own preferences

A Primary Agent with the relevant Fabric Controls can read its own display name, Awareness/Triggers/Recalled Lane Budgets and the linger defaults for trigger and recalled memories. It can change that name and request your approval for those memory changes. It cannot use these actions to edit another agent, change access, expose credentials or prepare a provider. A newer edit blocks an older request. If another change conflicts with yours in Agent Settings, Batshit protects the newer saved values. Check the current setting and use **Retry** if Batshit still cannot save your edit. See [Fabric](../fabric/overview.md#asking-an-agent-to-use-the-current-view).

See [App Actions](../fabric/app-actions.md) for approved changes an agent can make to supported settings, with your selected scope and permission.

## Related docs

- [Claude plan](../providers/claude-plan.md)
- [Connect n8n](connect-n8n.md)
- [Subagents](../subagents/overview.md)
- [Group Chat](../groups/overview.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Projects and files](../projects/overview.md)
- [Security and trust](../security/overview.md)
