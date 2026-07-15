# Streaming, recovery, and transparency

Batshit treats a live agent run as something you can watch, trust, and recover — not a black box that either finishes or fails. This page explains how live output, failure recovery, and visibility fit together: one streaming path that behaves the same across runtimes, compression that happens *while* output streams instead of after, failures that preserve work instead of discarding it, and a viewer that shows you what actually happened. You don't need any of this to use Batshit; it's here so you understand why a long, messy run stays affordable and survivable.

## One streaming path, regardless of runtime

Batshit's three runtimes — `n8n`, `API`, and `CLI` — produce output in genuinely different ways. A direct provider call streams tokens one at a time; an n8n workflow may run to completion and then hand back a result; a CLI agent emits its own command and file-edit events. Batshit normalizes all of them into a single canonical event stream — "here's some text," "a tool started," "here's its result," "the turn is done" — and that one stream drives one rendering path. The payoff: live text, tool cards, and [Zips](../tools/zips.md) look and behave the same no matter which runtime produced them. The deeper reasoning behind that convergence, and why it makes parity a real engineering discipline, lives in [Agents and runtime paths](agents-and-runtime-paths.md).

Two consequences matter here. First, because output is event-driven rather than tied to one browser session, **more than one tab can watch the same run live** — open a second tab on a mid-stream chat and it catches up with the same text and tool cards, in order. Second, the live "typing" feel can differ by runtime even though the result is identical: the `n8n` path in particular may deliver its answer in one piece after the workflow finishes, then replay it through the same renderer. Batshit doesn't fake token-by-token streaming where the runtime doesn't provide it.

## Tool output is compressed as it streams

When a tool returns something large — a long file, a big command output, a hefty API response — Batshit doesn't wait for the run to end before dealing with it. Tool results are turned into compact [Zips](../tools/zips.md) *during* streaming, at the moment each result arrives. The full content is stored once and the conversation carries a small reference to it.

This matters mid-run, not just at the end. Every turn re-sends the conversation so far, so if a tool-heavy run kept dragging full outputs through each step, the cost would climb fast while the agent was still working. Zipping as results stream in keeps the running context small from the first tool call onward, which is a direct lever on what the conversation costs. The token side of that story — how request shape and caching build on top of this — is covered in [Context, caching, and token optimization](context-caching-tokens.md).

## Failed work is preserved, not thrown away

Most chat apps treat a failed send as a dead end: the bubble vanishes, or you get a terse error and lose whatever the agent had already done. Batshit's stance is the opposite — partial work is still work.

If a run dies partway through for any reason — a provider error, a rate limit, a crash, or you deliberately stopping it — Batshit keeps what the agent already produced. The text it streamed and the tool results it gathered stay in the chat, under a clear failure banner that shows the **real** error text rather than a generic "something went wrong." That banner survives a reload, so a bad send can't come back later as a stuck "Thinking…" placeholder that quietly lies about what happened. (A run that fails before producing anything gets the same honest error state — there's just no partial work to keep.)

One subtle detail makes continuation possible. Batshit normally compresses tool output into Zips aggressively, but the results from an *unfinished* run are deliberately held un-compressed — even types that would normally auto-Zip — so that when you tell the agent to continue, it can still read exactly what it was doing. Normal compression resumes once the agent completes a clean turn, and your manual controls always win if you'd rather compress sooner. The how-to side of stopping and continuing lives in [Compact and Trim](../chat/compact-and-trim.md).

## Running out of context doesn't end the task

Long, tool-heavy runs can fill a model's context window before the work is actually done. A naive system either fails hard at that wall or loops forever pretending to make progress. Batshit aims for the honest middle.

For managed `CLI` agents (Codex and Claude Code), Batshit watches token usage live and stops the turn *gracefully* at roughly 80% of the context window — before the model slams into its limit. The failure note reads "Batshit context guard," and that's by design: it's a clean, intentional stop, not a crash. Batshit then finalizes the partial work (so its tool results live in history as compact Zips that cost almost nothing) and automatically starts a fresh continuation that reads that saved history and picks up where it left off. Because the continuation starts from compressed history rather than the dead run's bloated internal context, it has far more room to keep going.

The crucial guardrail: auto-continue is **capped at a few continuations** per request. A task that genuinely can't fit will stop with a visible error instead of looping forever and quietly burning through model calls. That cap is the difference between resilient and reckless. Group chats don't auto-continue at all — a failed turn stays preserved and you ask the group to continue normally. The user-facing controls for all of this are in [Compact and Trim](../chat/compact-and-trim.md).

## Transparency: the Execution Viewer

Everything above — compression, recovery, continuation — only earns your trust if you can *check* it. That's the whole point of the [Execution Viewer](../chat/execution-viewer.md): instead of asking you to believe a marketing line about what Batshit sent or how a run behaved, it shows you.

For any agent turn, the Execution Viewer is a read-only window into what actually happened: the compiled prompt the model received, the tools that ran and what they returned, the runtime that handled the turn, and the token accounting — including, where a provider reports it, how much was read from cache versus freshly billed. When a run does something surprising — fails oddly, costs more than you expected, or seems to "forget" something — the Execution Viewer is where you look before you start changing settings at random. A clear snapshot beats a guess every time.

This is the thread that ties the section together: stable things stay reusable, bulky things get compressed before a provider sees them, failures preserve work, and Batshit shows you the evidence rather than asking for faith.

## Related

- [Execution Viewer](../chat/execution-viewer.md) · [Compact and Trim](../chat/compact-and-trim.md)
- [Agents and runtime paths](agents-and-runtime-paths.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
- [Zips](../tools/zips.md)
- [How Batshit works](overview.md)
