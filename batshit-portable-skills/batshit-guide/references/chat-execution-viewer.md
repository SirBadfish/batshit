# Execution Viewer

Most AI apps hide the prompt. You send a message, an answer comes back, and what the model *actually* received is a black box. Batshit doesn't work that way. The Execution Viewer is a side sheet that shows you exactly what an agent was sent, what it sent back, which model and runtime ran it, and what the tokens looked like.

When an agent does something surprising, you don't have to guess — you look.

## What it shows

Open the Execution Viewer on a message to inspect that run:

- The compiled prompt and system prompt the agent actually received.
- The per-turn runtime context (the Dynamic Current Message — see below).
- Token counts and badges, so you can see what the request cost in context. When a provider reports prompt-cache reads or cache creation/write tokens, Batshit normalizes those into the same token evidence instead of hiding them in raw logs.
- Tool calls and their results.
- Subagent and Worker runs, with separate usage and status evidence.
- The model and runtime path that handled the turn.

It's read-only — a window into the run, not a place you edit anything. Think of it as the receipt for every agent turn.

## When to reach for it

- An agent says it can't see a Subagent, tool, or file you expected it to have.
- A response ignores context you thought you provided.
- You want to know why a turn cost as much context as it did.
- A tool call returned something weird and you want the raw evidence.
- You're tuning a system prompt and want to confirm what's really being sent.

The rule of thumb: when behavior surprises you, check the Execution Viewer before you start changing settings at random. A clear snapshot beats a guess every time.

## The Dynamic Current Message (DCM)

Here's a concept that's new to most people. Every time you send a message, Batshit assembles an extra block of context just for that turn — the **Dynamic Current Message**, or DCM. It's built fresh on every send and is never saved as part of your chat history.

The DCM is how the agent knows about the *current state of your workspace* right now, including things like:

- Your active Project path and any files you mentioned.
- Which Subagents this agent can call, with their model, tool capabilities, Skills, and resumable-thread status. The roster lives **only** in the DCM; general instructions for using Subagents and Workers live in the system prompt.
- Whether Workers are enabled and their current limits.
- The tools and capabilities the agent can discover this turn.
- Current Zip and Clip state.
- Goon cues and other per-turn context, where relevant.

Why it matters to you: if an agent "doesn't know it has a Subagent" or "can't find a tool," the DCM is where you confirm what it was actually told. Because the DCM is rebuilt every turn rather than stored, the Execution Viewer is the place to see what a given send really contained. The Tool Grid's display-detail setting controls how much tool information the DCM includes — turn it up when an agent needs richer hints, down to save context.

## Delegated runs

The **Delegated runs** table shows the Subagents and Workers called during a message. Each row identifies the helper, its type and model when known, status, duration, reported token usage, and thread outcome. A Worker has no stored thread. A failed or timed-out run remains visible as such.

Delegated usage contributes to the Token Panel's running conversation totals and cost, with a separate subtotal in the cost tooltip. It does **not** inflate the Primary Agent's context meter: the helper ran in a separate context. The result returned to the Primary Agent still uses space in its own conversation.

Unknown usage or unavailable pricing stays unknown. In particular, the official n8n Workflow Subagent templates do not return usage; a custom workflow can report it. Claude Code's native helpers are labeled **Claude Code Helper** and do not receive Batshit's separate Worker accounting.

## Schema Hints

A related new idea: when an agent uses Dynamic Tool Search, Batshit doesn't dump every tool's full definition into the prompt. Instead it returns **Schema Hints** — compact, on-demand descriptions of just the tool the agent picked. The agent gets enough to call the tool correctly, without paying the token cost of every tool's schema up front. You'll see these hints in tool-search results when you inspect a run. More on the search-then-use pattern in [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md).

## Related docs

- [Tools, MCPs, CLI Tools, and Skills](../tools/overview.md)
- [Zips and context](../tools/zips.md)
- [Primary Agents](../primary-agents/overview.md)
- [Subagents](../subagents/overview.md)
