# Agents and runtime paths

Every Primary Agent runs in Batshit, on the saved model you pick. The model's connection decides how Batshit reaches the model: an API key, a Local AI runtime, your ChatGPT plan or your Claude plan. n8n remains an automation runtime that Primary Agents use through workflow tools.

## One experience, one Primary Agent runtime

Batshit builds the request, supplies the enabled tools, runs every tool itself, and streams the reply, whatever the connection. On the Claude plan connection, Claude Code acts only as the model: its own tools are off, and the model sees only the Batshit tools you allow.

Every agent shares the same user experience: chats, Projects, Clips, Zips, tools, memory, voice, Goons, and the Execution Viewer, where its model supports them. [Claude plan](../providers/claude-plan.md) lists what that connection does not run.

The older Claude Code CLI lane, where Claude Code ran a whole agent with its own tools and loop, was removed. A leftover agent from it can only be deleted; see [Primary Agents](../primary-agents/overview.md#claude-code-cli-agents-were-removed).

## One compiler and one event contract

Batshit uses one server-side compiler for every Primary Agent's system prompt, chat history, memory, project context, Tool Grid scope, and current-message information block, whatever the model connection. That avoids two implementations silently assembling different requests.

Each connection emits its own native events, but Batshit normalizes them into one event contract for text, reasoning, tool calls, tool results, errors, and completion. The renderer therefore uses the same tool cards, Zip behavior, and spectator-tab replay whichever connection the run used.

## Where n8n fits

n8n is an automation platform in Batshit, not a kind of agent:

- **Workflow tools** let a Primary Agent call a normal n8n workflow for a task.
- **Wake-up webhooks** let an n8n workflow start a chat for one of your agents.

## Subagents

A Primary Agent can call Subagents: Batshit-managed runs on their own saved model, on any connection, the Claude plan included. They compile from the same base pattern as every agent, run as non-streaming tool-like calls, inherit only the parent Project path, and use their own Tool Grid settings. On the Claude plan, Claude Code acts only as the model for a Subagent too.

The Claude Code CLI Subagent, where Claude Code ran the Subagent with its own tools, was removed. A leftover one can only be deleted; see [Subagents](../subagents/overview.md).

## Why this matters

The connection choice determines where the model runs, how it authenticates and pays, and which model features it offers. It does not define a premium tier.

A common setup is one agent on a fast everyday model, another on a strong coding model (on an API key or your Claude plan), and n8n workflow tools for automation-heavy jobs.

## Related

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
- [Streaming, recovery, and transparency](streaming-and-recovery.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
