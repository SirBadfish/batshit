# Subagents and Workers

A Subagent is a smaller assistant a Primary Agent can call when it needs specialized help. You still talk to the Primary Agent. It decides when to call a Subagent, hands it a task, receives the result, and continues the conversation.

Think of Subagents as teammates the Primary Agent delegates to, not as general MCP tools. They show up internally as tool calls, but the idea is still "an assistant called by another assistant."

A **Worker** is a temporary helper for one task. Your Primary Agent can start Workers without creating a saved specialist first. It receives their results and stays responsible for the answer you see.

## One kind of Subagent

Every Subagent works the same way: Batshit runs it, with Batshit's tools and features, on the saved model you pick. The model's connection decides how it reaches the model and how it pays: an API key, a Local AI runtime, your ChatGPT plan or your Claude plan. Any Primary Agent can be given any Subagent. When you create one there is no type to pick, and Settings names none: every Subagent is simply a Subagent.

For a Claude helper, make a Subagent and pick a Claude plan model (see [Claude plan](../providers/claude-plan.md)). Claude Code then acts only as the model. Batshit runs every tool, under the Work mode set in the Subagent's Agent Settings, the Sandbox, your allow and Always Block lists and the guard on Batshit's own source code, the same as for any other Subagent.

## Removed Subagent types

Older kinds of Subagent were removed. Batshit does not convert them.

- **Claude Code CLI and Codex CLI Subagents**, where Claude Code or Codex ran the Subagent with its own tools. A leftover one stays in your Settings list so you can delete it, but it does not run: your Primary Agents no longer see or call it, it drops out of their assigned Subagents, and its Agent Settings say "Claude Code CLI Subagents were removed from Batshit." (or "Codex CLI Subagents were removed from Batshit.") and can't be saved. In a Primary Agent's **Assigned Subagents** card it is still listed, with a **Removed Type** badge beside a switch that stays off. Delete it like any other Subagent; see [Changing or deleting a Subagent](#changing-or-deleting-a-subagent).
- **n8n Workflow Subagents.** A saved one no longer runs and no longer appears in Settings. Your n8n workflows are not affected: a workflow can still be a tool your Primary Agent calls, as [Connect n8n](../primary-agents/connect-n8n.md) explains.

To get a removed specialist back, create a Subagent with the same description and instructions and pick a model for it.

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

The Primary Agent receives assigned Subagents’ descriptions, models, tools and Skills through Agent Setup and current change notes. Current conversation availability stays in the Dynamic Current Message (DCM): resumable, no conversation, or unavailable when its check fails. Unavailable does not mean a stored conversation was deleted. Inspect these in the [Execution Viewer](../chat/execution-viewer.md).

The system prompt separately teaches the Primary Agent when and how to delegate. **Every Primary Agent receives this guidance by default**, because Workers start enabled. To remove it from an agent with no assigned Subagents, turn **Workers** off in Agent Settings beside the Subagent assignments. An agent with assigned Subagents still needs the delegation guidance when Workers are off. The setting takes effect on the next message without reloading Batshit.

## How a Subagent differs from a tool

A tool performs a specific action: run a command, search a gateway, call a workflow, read a result, or invoke an Artifact.

A Subagent thinks and responds as an assistant. It can have its own name, description, system prompt, model settings, tool discoverability, avatar, and a saved conversation to resume. The Primary Agent sees Subagents as callable helpers and picks the one that fits your request.

## What the Primary Agent sends

When a Primary Agent calls a Subagent:

- The Subagent receives its base instructions.
- It receives its user-authored system prompt.
- It may receive the global user prompt, if that setting is enabled for it.
- It receives the active Project path from the parent conversation.
- It uses its own tool settings, not the parent's full Tool Grid.

Subagents inherit only the parent Project path. They do not automatically inherit every tool, MCP gateway, CLI tool, Dynamic Current Message setting, or display setting from the Primary Agent.

## Tool scope

Each Subagent has its own Tool Grid. Depending on its configuration, a Subagent can use families such as:

- Batshit Tool Search/Use for assigned MCP tools, saved CLI Tools, Agent Browser capabilities, and published Artifact runtime tools.
- Web Search.
- Bash or sandbox-backed command execution, where supported.
- Assigned Skills and Prompts.

Broad Batshit control-plane tools stay Primary Agent territory. Subagents can use published Artifact runtime tools, but they do not get broad Fabric controls for changing the whole app.

Fetch Zip reaches a Subagent when its Fetch Zip toggle is on. When it is off, have the Primary Agent fetch or summarize the zip first.

## Start fresh or continue a conversation

Subagent calls start **fresh** by default. The Subagent gets the task the Primary Agent sends, without the conversation from its previous call.

The Primary Agent can ask to **resume** when a follow-up depends on the Subagent's previous work. For example, after a code review, it can ask the same specialist to check the corrected version in the same conversation.

- A fresh call **erases the stored thread**. It does not set it aside for later. Do not start fresh between calls you want to resume.
- Resuming without a previous thread starts fresh and reports that fact.
- Each Subagent has one thread per chat. A new chat starts separately; Group Chat members who share a Subagent also share its thread.
- Calls to the same Subagent wait for each other, so they cannot overwrite the same conversation. Different Subagents can work at the same time.

The tool argument is `thread: "fresh"` or `thread: "resume"`; normally your Primary Agent chooses it from your request.

## Workers

Workers handle independent research, review, drafting, or other focused tasks in parallel. Each runs once, returns a result, and keeps no conversation to resume. They receive the task brief and the active Project path, without inheriting the parent chat history, Clips, or global custom prompt.

There are two choices:

| Worker | Model and instructions | Tools and Skills |
| --- | --- | --- |
| Built-in general Worker | Uses the Primary Agent's model and connection, with Batshit's Worker instructions. | Inherits the parent's enabled tool scope, **not the parent's Skills**. |
| Fresh copy of a specialist | Uses an assigned Subagent's model and custom instructions. | Keeps that Subagent's own tools and Skills, without its saved conversation. |

The Primary Agent selects the specialist with the `base` argument.

Workers cannot use broad app-management or memory tools, call Subagents, or start more Workers. Subagents also cannot delegate further. Both must finish without pausing for user approval. Their output is a result for the Primary Agent to check.

Batshit runs **up to six Workers at a time**, and up to six in one call. A reply can start another batch when the previous batch finishes. Going over the limit returns a clear refusal. The Workers card shows each helper's status, duration, reported usage and result. Workers operate within the speaking agent's turn in Group Chat.

The **Claude Code Helper** card belonged to the removed CLI lanes. Older chats retain those saved cards; current helpers use Batshit Workers.

## Time limits, tool steps, and cost

Subagent and Worker calls have **no time limit and no tool-step limit by default**. **Stop** on the Primary Agent's reply ends its Subagent and Worker runs too.

Batshit stops a delegated run after **10 minutes without progress** and explains why. Model output, a tool starting and a tool result count as progress. A tool still running is not treated as silence; tools keep their own time limits.

You can set limits in a Subagent's Agent Settings:

- **Call Timeout:** blank means no limit. Set 10–86400 seconds (24 hours) to impose one. A call that runs out of time returns as timed out.
- **Max Tool Steps:** blank means no limit. Set 1–10000 tool calls. At the limit, the result is **Partial** and includes work so far; the Primary Agent can resume the Subagent to continue.

A model that reaches its output limit also returns a **Partial** result with its words so far and a note that they may be cut off. A built-in Worker has no limits of its own; a fresh specialist copy follows that specialist's limits.

Call Timeout covers the run, not its wait behind another call to the same Subagent. Batshit explains that wait in the result. Use Workers for independent work that needs to run at the same time.

The Token Panel includes reported Subagent and Worker usage in the conversation's token and cost totals. The context meter measures only the Primary Agent's own context: a helper's entire conversation does not count against that window, although its returned result does. The [Execution Viewer](../chat/execution-viewer.md#delegated-runs) lists each delegated run separately. Missing usage or pricing is shown as unknown, not zero.

## Non-streaming behavior

Subagent runs are tool-like and non-streaming. The Primary Agent waits for the result, then continues the visible response:

- You usually see a Subagent call card or summarized result, not a character-by-character Subagent stream.
- The Primary Agent stays responsible for the final answer.
- A Subagent can do focused work without taking over the chat.

## Running a Subagent on a saved model

A Subagent runs on a saved model, so you can add a specialist without building another workflow. This is a good default for lightweight research, writing, review, and analysis specialists.

Good fits:

- You want fast, direct setup.
- You want your model connection (a provider key, a Local AI runtime or a plan sign-in) managed in Batshit.
- You want a specialist with narrower tools than the Primary Agent.


For coding and repository work, pick a strong coding model, for example a Claude plan model. The Subagent works in the parent chat's Project with Batshit's own Bash and file tools, under its Work mode.

## Setup checklist

1. Create the Subagent in Settings.
2. Give it a short, specific description; the Primary Agent uses this to decide when to call it.
3. Add the Subagent's system prompt.
4. Choose a saved model and its runtime settings. A Subagent runs through that saved model's connection (for example Google directly, OpenRouter, or your Claude plan), the same way a Primary Agent does. If the model field says to pick the model again, pick it once; until then that Subagent refuses to run rather than guess a connection.
5. Configure its Tool Grid.
6. Assign it to one or more Primary Agents.
7. Send a test request that clearly asks for that specialist.


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

Settings → Agents → the Subagent → delete. This removes the Subagent and everything that is only its own: its settings, its avatar pictures, and, for a leftover Claude Code CLI or Codex CLI Subagent, its folder of managed CLI settings under `~/.batshit/agents/` (that folder also holds the CLI's own log of the Subagent's prompts). It also drops the Subagent from every Primary Agent it was assigned to, from skill or artifact lists that named it, and erases its thread in each of your chats. If a reply is using the Subagent when you delete it, Batshit stops that call first and waits for it to end before deleting anything. If it has not ended within 30 seconds, nothing is deleted and the error asks you to retry. If Batshit cannot verify command cleanup, it keeps the Subagent and its CLI folder. This safeguard also applies after an app restart: host-side records can block deletion while a recorded program still runs or cannot be checked. The error names a recorded live program so you can end it yourself and retry, or restart the computer and retry. When Batshit verifies that only the recorded programs ended, it may still warn that other commands from the old run could remain.

The avatar pictures are stored by batshit-server, so Batshit checks that batshit-server is running before it deletes anything. If it is not running, nothing is deleted and the error says so. Restart Batshit (in Docker, run `./start-docker.sh`) and delete the Subagent again.

## Common problems

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| Subagent does not appear for an agent | It is not assigned, it was an n8n Workflow Subagent (which no longer runs or appears), or it is a leftover Claude Code CLI or Codex CLI Subagent. | The Primary Agent's assigned Subagents. A leftover shows **Removed Type** beside a switch that stays off; delete it and create a new Subagent. |
| Primary Agent never calls it | The description is too vague or off-topic. | Rewrite the description as a clear specialty. |
| Subagent cannot use a tool | Its Tool Grid does not enable that tool. | The Subagent's Tools settings. |
| A Subagent on the Claude plan is not signed in | Claude Code needs your plan sign-in. | Settings → API Keys → Claude Plan. |
| A Subagent says its CLI type was removed | It is a leftover of a removed type. | Delete it and create a Subagent on a saved model. |

## Related docs

- [Claude plan](../providers/claude-plan.md)
- [Primary Agents](../primary-agents/overview.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Security and trust](../security/overview.md)
