# Subagents and Workers

A Subagent is a smaller assistant a Primary Agent can call when it needs specialized help. You still talk to the Primary Agent. It decides when to call a Subagent, hands it a task, receives the result, and continues the conversation.

Think of Subagents as teammates the Primary Agent delegates to, not as general MCP tools. They show up internally as tool calls, but the idea is still "an assistant called by another assistant."

A **Worker** is a temporary helper for one task. Your Primary Agent can start Workers without creating a saved specialist first. It receives their results and stays responsible for the answer you see.

## Subagent types

Batshit has three Subagent types:

| Type | What it means | Can be assigned to |
| --- | --- | --- |
| `n8n Workflow Subagent` | A separate n8n workflow with its own webhook, called like a specialist. | `API` and `CLI` Primary Agents. |
| `API Subagent` | A Batshit-managed direct-provider specialist run. | `API` and `CLI` Primary Agents. |
| `CLI Subagent` | A Batshit-managed one-shot Codex or Claude Code specialist run. | `API` and `CLI` Primary Agents. |

Each n8n Workflow, API, and CLI Subagent can be assigned to either live Primary Agent type.

A CLI Subagent has its own Codex or Claude mode in Agent Settings. Codex shows its saved Sandbox Level, or the mode's own level when none was saved. **Agent (full access)** disables the level control and keeps any tighter level saved in an older record; pick **Agent** to adjust it. Claude offers **Plan**, **Ask before edits**, **Edit automatically**, and **Bypass permissions**. CLI Subagents have no approval cards: a request that needs permission fails instead of waiting for a user.

## When to use a Subagent

Use a Subagent when a recurring piece of work deserves its own instructions, model, tools, or personality. Good fits:

- A research specialist.
- A code reviewer.
- A document drafter.
- An n8n workflow analyst.
- A creative brainstorming partner.
- A data extractor.
- A tool-heavy helper with narrower permissions than the Primary Agent.

For a small one-off action with a clear input and output, a normal tool is usually simpler.

## How the Primary Agent chooses a helper

Each message includes a current roster of assigned Subagents: their descriptions, type, model, tool capabilities, assigned Skills, and whether a conversation can be resumed. This roster lives in the Dynamic Current Message (DCM), which you can inspect in the [Execution Viewer](../chat/execution-viewer.md). For n8n Workflow Subagents, the roster says the tools are defined in n8n.

The system prompt separately teaches the Primary Agent when and how to delegate. **Every API and CLI Primary Agent receives this guidance by default**, because Workers start enabled. To remove it from an agent with no assigned Subagents, turn **Workers** off in Agent Settings beside the Subagent assignments. An agent with assigned Subagents still needs the delegation guidance when Workers are off. The setting takes effect on the next message without reloading Batshit.

## How a Subagent differs from a tool

A tool performs a specific action: run a command, search a gateway, call a workflow, read a result, or invoke an Artifact.

A Subagent thinks and responds as an assistant. It can have its own name, description, system prompt, model settings, tool discoverability, avatar, and—when the backing runtime supports it—saved memory. The Primary Agent sees Subagents as callable helpers and picks the one that fits your request.

## What the Primary Agent sends

When a Primary Agent calls a Subagent:

- The Subagent receives its base instructions.
- It receives its user-authored system prompt.
- It may receive the global user prompt, if that setting is enabled for it.
- It receives the active Project path from the parent conversation.
- It uses its own tool settings, not the parent's full Tool Grid.

Subagents inherit only the parent Project path. They do not automatically inherit every tool, MCP gateway, CLI tool, Dynamic Current Message setting, or display setting from the Primary Agent.

## Tool scope

Each Subagent has its own Tool Grid. Depending on type and configuration, Subagents can use families such as:

- Batshit Tool Search/Use for assigned MCP tools, saved CLI Tools, Agent Browser capabilities, and published Artifact runtime tools.
- Web Search.
- Bash or sandbox-backed command execution, where supported.
- Assigned Skills and Prompts.
- Approved runtime add-on actions.

Broad Batshit control-plane tools stay Primary Agent territory. Subagents can use published Artifact runtime tools, but they do not get broad Fabric controls for changing the whole app.

Fetch Zip reaches a Subagent only on the API lane, when its Fetch Zip toggle is on. CLI and n8n Workflow Subagents never get it, so have the Primary Agent fetch or summarize the zip first.

## Start fresh or continue a conversation

Subagent calls start **fresh** by default. The Subagent gets the task the Primary Agent sends, without the conversation from its previous call.

The Primary Agent can ask to **resume** when a follow-up depends on the Subagent's previous work. For example, after a code review, it can ask the same specialist to check the corrected version in the same conversation.

- A fresh call **erases the stored thread**. It does not set it aside for later. Do not start fresh between calls you want to resume.
- Resuming without a previous thread starts fresh and reports that fact.
- Each Subagent has one thread per chat. A new chat starts separately; Group Chat members who share a Subagent also share its thread.
- Calls to the same Subagent wait for each other, so they cannot overwrite the same conversation. Different Subagents can work at the same time.

The tool argument is `thread: "fresh"` or `thread: "resume"`; normally your Primary Agent chooses it from your request. n8n Workflow Subagents need the current official template, or the matching [thread-key setup](../resources/n8n-workflow-templates.md#conversation-threads), to honor this choice.

## Workers

Workers handle independent research, review, drafting, or other focused tasks in parallel. Each runs once, returns a result, and keeps no conversation to resume. They receive the task brief and the active Project path, without inheriting the parent chat history, Clips, or global custom prompt.

There are two choices:

| Worker | Model and instructions | Tools and Skills |
| --- | --- | --- |
| Built-in general Worker | Uses the Primary Agent's model and API connection or CLI, with Batshit's Worker instructions. | Inherits the parent's enabled tool scope, **not the parent's Skills**. |
| Fresh copy of a specialist | Uses an assigned API or CLI Subagent's model and custom instructions. | Keeps that Subagent's own tools and Skills, without its saved conversation. |

The Primary Agent selects the specialist with the `base` argument. n8n Workflow Subagents cannot be copied into Workers because n8n owns their workflow and memory; call those as Subagents instead.

Workers cannot use broad app-management or memory tools, call Subagents, or start more Workers. Subagents also cannot delegate further. Both must finish without pausing for user approval. Their output is a result for the Primary Agent to check.

Batshit allows **three Workers in one call, three running at once, and nine Worker runs during one Primary Agent turn**. Going over a limit returns a clear refusal. The Workers card shows each helper's status, duration, reported usage, and result. Workers operate within the speaking agent's turn in Group Chat.

Claude Code can also run its own native helpers. These are labeled **Claude Code Helper**; Batshit's Worker limits and thread controls do not govern them. The card shows the helper's answer; the helper's own steps are not shown as separate cards. If a helper starts one of your Batshit Subagents or Workers, that run still counts in the reply's spend.

## Time limits and cost

API and n8n Workflow Subagents default to three minutes per call; CLI Subagents default to five minutes. Set **Call Timeout** in the Subagent's Agent Settings to override its default with 10–600 seconds, or leave it blank to use the default. Workers default to three minutes; a copy of a specialist honors that specialist's explicit timeout override. A timeout is shown as a timed-out result, not a completed task. Pressing **Stop** on your agent's reply ends its Subagent and Worker runs too, on API and CLI agents alike, instead of leaving them to run until their time limit.

Call Timeout covers the call itself, not time spent waiting for a turn. Batshit runs one call per Subagent at a time so its thread stays intact, so if your agent calls the same Subagent twice at once, the second call waits for the first to finish and can take up to about twice its Call Timeout overall. Batshit says so in the result when that happens, so a long call is never unexplained. Use Workers for work that should genuinely run at the same time — they do not wait in line.

The Token Panel includes reported Subagent and Worker usage in the conversation's token and cost totals. The context meter measures only the Primary Agent's own context: a helper's entire conversation does not count against that window, although its returned result does. The [Execution Viewer](../chat/execution-viewer.md#delegated-runs) lists each delegated run separately. Missing usage or pricing is shown as unknown, not zero; the official n8n templates do not report token usage.

## Non-streaming behavior

Subagent runs are tool-like and non-streaming. The Primary Agent waits for the result, then continues the visible response:

- You usually see a Subagent call card or summarized result, not a character-by-character Subagent stream.
- The Primary Agent stays responsible for the final answer.
- A Subagent can do focused work without taking over the chat.

## n8n Workflow Subagents

Use an `n8n Workflow Subagent` when the specialist logic belongs in n8n. It is a separate workflow with its own webhook, model node, credentials, prompt, and optional tools.

Good fits:

- The specialist needs n8n credentials or nodes.
- You want visual workflow history for the specialist.
- You want the specialist's implementation to stay editable in n8n.
- The workflow has a conversational or reasoning role, not just one fixed action.

Import the official host/local or Docker Workflow Subagent template, configure its credentials, activate it, paste its Production webhook into Batshit, and assign it to an `API` or `CLI` Primary Agent.

See [Connect n8n](../primary-agents/connect-n8n.md).

## API Subagents

Use an `API Subagent` to run a direct-provider specialist without building another workflow. This is a good default for lightweight research, writing, review, and analysis specialists.

Good fits:

- You want fast, direct setup.
- You want provider keys managed in Batshit.
- You want a specialist with narrower tools than the Primary Agent.

## CLI Subagents

Use a `CLI Subagent` when the specialist should use a managed CLI lane for a one-shot task. This is useful for coding, repository inspection, and CLI-native reasoning, but it is deliberately non-interactive—configure it so it can finish without asking the user for approval mid-run.

Good fits:

- The specialist needs CLI-native project behavior.
- The delegated task is code-heavy.
- You want a strong one-shot helper while the Primary Agent keeps owning the conversation.

Docker note: CLI Subagents need the CLI authenticated in the Docker app container, just like CLI Primary Agents.

## Setup checklist

1. Create the Subagent in Settings.
2. Pick `n8n Workflow`, `API`, or `CLI`.
3. Give it a short, specific description; the Primary Agent uses this to decide when to call it.
4. Add the Subagent's system prompt.
5. Choose a saved model and its runtime settings. An API Subagent runs through that saved model's connection (for example Google directly, or OpenRouter), the same way a Primary Agent does. If the model field says to pick the model again, pick it once; until then that Subagent refuses to run rather than guess a connection.
6. Configure its Tool Grid.
7. Assign it to one or more `API` or `CLI` Primary Agents.
8. Send a test request that clearly asks for that specialist.

Good descriptions are specific:

- "Reviews TypeScript and Svelte changes for bugs, regressions, missing tests, and launch-readiness risk."
- "Summarizes long n8n workflows and explains each branch in plain English."
- "Drafts user-facing documentation in warm, non-technical language."

A Subagent can't use a name that a Primary Agent already uses, and a new Primary Agent can't use a Subagent's name. Skill and artifact access lists name agents and Subagents the same way, so two of them with one name would share that access. Pick another name if Batshit says the name is taken.

## Saving Agent Settings

Agent Settings saves changes automatically. While a save for the shown agent is still on its way, its controls are temporarily read-only. You can select another agent while it finishes. A draft waiting to save, or a field that needs correcting, stays editable.

If changing **Assigned Subagents** fails, the error beside that card shows Batshit's reason when one is available.

After 30 seconds without an answer, Settings shows a notice with **Retry**. Retry reads the saved record; it does not cancel the original save. Your draft stays visible, and choices that save several related values or a whole list wait for a successful read and for that agent’s pending writes to settle. If the read fails, use Retry; Settings keeps your draft.

## Changing or deleting a Subagent

When you upload a new avatar picture, clear it, or choose an icon, the old picture is deleted once the change saves. If the change can't save (for example the name is empty), the old picture stays, so the Subagent never points at a picture that is gone.

Settings → Agents → the Subagent → delete. This removes the Subagent and everything that is only its own: its settings, its avatar pictures, and, for a `CLI Subagent`, its folder of managed CLI settings under `~/.batshit/agents/` (that folder also holds the CLI's own log of the Subagent's prompts). It also drops the Subagent from every Primary Agent it was assigned to, from skill or artifact lists that named it, and erases its thread in each of your chats. If a reply is using the Subagent when you delete it, Batshit stops that call first and waits for it to end before deleting anything. If it has not ended within 30 seconds, nothing is deleted and the error asks you to retry. If Batshit cannot verify command cleanup, it keeps the Subagent and its CLI folder. This safeguard also applies after an app restart: host-side records can block deletion while a recorded program still runs or cannot be checked. The error names a recorded live program so you can end it yourself and retry, or restart the computer and retry. When Batshit verifies that only the recorded programs ended, it may still warn that other commands from the old run could remain.

The avatar pictures are stored by batshit-server, so Batshit checks that batshit-server is running before it deletes anything. If it is not running, nothing is deleted and the error says so. Restart Batshit (in Docker, run `./start-docker.sh`) and delete the Subagent again.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Subagent does not appear for an agent | It is not assigned, or the saved record uses a retired type. | The Primary Agent's assigned Subagents and the Subagent type. |
| Primary Agent never calls it | The description is too vague or off-topic. | Rewrite the description as a clear specialty. |
| Subagent cannot use a tool | Its Tool Grid does not enable that tool. | The Subagent's Tools settings. |
| n8n Workflow Subagent fails | Webhook, scoped native-tool auth, callback URL, or n8n credentials are wrong. | n8n execution history, `x-batshit-native-tool-token`, and `parent_agent_id`. |
| CLI Subagent fails with login/auth errors | The CLI is not authenticated where Batshit runs it. | For Docker, authenticate inside the app container. |

## Related docs

- [Primary Agents](../primary-agents/overview.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Security and trust](../security/overview.md)
