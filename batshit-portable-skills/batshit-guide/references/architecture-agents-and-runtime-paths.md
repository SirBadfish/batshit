# Agents and runtime paths

Batshit has two Primary Agent types: `API` and `CLI`. They are peer choices, not quality tiers. n8n remains an automation runtime that Primary Agents use through workflow tools and n8n Workflow Subagents.

## One experience, two Primary Agent runtimes

- **`API`** — Batshit talks directly to a model provider or Local AI runtime. Batshit builds the request, supplies enabled tools, and streams the reply.
- **`CLI`** — Batshit runs a managed Codex or Claude Code agent. The CLI brings its own coding-oriented command, search, and file-edit behavior while Batshit owns the chat, history, settings, and visual output.

Both types share the same user experience: chats, Projects, Clips, Zips, tools, memory, voice, Goons, and the Execution Viewer. Pick API for broad provider access and Local AI; pick CLI when a native coding agent is the better fit.

## One compiler and one event contract

API and CLI Primary Agents use one server-side compiler for system prompts, chat history, memory, project context, Tool Grid scope, and the current-message information block. That avoids two implementations silently assembling different requests.

Their runtimes emit different native events, but Batshit normalizes both into one event contract for text, reasoning, tool calls, tool results, errors, and completion. The renderer therefore uses the same tool cards, Zip behavior, and spectator-tab replay regardless of whether the run came from a direct provider, Codex, or Claude.

## Where n8n fits

n8n is a Category 2 automation platform in Batshit:

- **Workflow tools** let a Primary Agent call a normal n8n workflow for a task.
- **n8n Workflow Subagents** let a Primary Agent delegate to a dedicated n8n AI Agent workflow.

n8n does not appear as a Primary Agent type. You do not chat directly through an n8n Primary webhook, and the retired n8n Subnode Subagent type is not available.

## Subagent lanes

API and CLI Primary Agents can call three kinds of Subagent:

- **n8n Workflow Subagent** — a dedicated n8n webhook workflow.
- **API Subagent** — a Batshit-managed direct provider run.
- **CLI Subagent** — a Batshit-managed one-shot Codex or Claude run.

All three compile from the same base pattern, run as non-streaming tool-like calls, inherit only the parent Project path, and use their own Tool Grid settings.

## Why this matters

The runtime choice determines where the model runs, how it authenticates, and which native capabilities it can reach. It does not define a premium tier.

A common setup is an API Primary Agent for general work, a CLI Primary Agent for code, and n8n Workflow Subagents or workflow tools for automation-heavy jobs.

## Related

- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
- [Connect n8n](../primary-agents/connect-n8n.md)
- [Streaming, recovery, and transparency](streaming-and-recovery.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
