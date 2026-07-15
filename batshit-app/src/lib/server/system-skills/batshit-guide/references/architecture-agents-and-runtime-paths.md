# Agents and runtime paths

Batshit gives you three kinds of Primary Agent — `n8n`, `API`, and `CLI` — and underneath, they are three genuinely different ways to reach an AI model. This page explains how those runtimes work, why Batshit funnels all of them through one shared contract, and why the runtime you pick is a decision about *where the model lives and what it can reach* — not a quality tier. For how to set each one up, see [Primary Agents](../primary-agents/overview.md); this is the deeper "why and how."

## One experience, three runtimes

A Primary Agent is the AI you talk to directly. The interesting part is that "the AI" can be running in three completely different places:

- **`n8n`** — the agent is an actual n8n workflow. Your message goes out to an n8n webhook, n8n's own AI Agent node does the thinking, and the answer comes back. The model, its credentials, and any branching logic all live inside n8n.
- **`API`** — Batshit talks straight to a model provider through its own built-in path. There's no workflow in the middle; Batshit shapes the request, sends it, and streams the reply.
- **`CLI`** — Batshit runs a managed command-line agent (Codex or Claude Code) inside the chat. The CLI brings its own native command, search, and file-editing behavior; Batshit hosts it.

These aren't three skins over the same engine. They're three engines. So why bother supporting all three instead of shipping one and calling it a day?

Because the right runtime depends on the work. Someone who already lives in n8n wants their workflow to *be* the assistant. Someone who just wants fast, direct chat with Batshit-native tools wants the `API` path. Someone doing heavy code and repo work wants a real CLI agent's instincts. Forcing everyone down one path would mean either a worse fit for two of those three people — or three separate products to learn. Batshit's bet is the opposite: let you pick the runtime that fits, and make the *experience* on top of it identical. Same chat, same saved history, same Projects, same Clips and Zips, same Execution Viewer. What changes is the path to the model. What you see and touch does not.

## Convergence to one contract

Making three different runtimes feel like one product is not free, and it doesn't happen by accident. The mechanism is convergence: no matter how an agent produces output, Batshit normalizes that output into a single canonical shape — one stream of events that says "here's some text," "a tool just started," "here's its result," "the turn is done." Everything the app renders is driven by that one event stream.

That single funnel is why a tool card, a [Zip](../tools/zips.md) reference, or live streaming output looks the same whether the work came from an n8n workflow, a direct provider call, or a CLI agent. The rendering pipeline never has to know which runtime it's looking at, because by the time output reaches it, the differences have already been ironed out.

The honest cost of this design is that *parity across the three* becomes a real engineering discipline rather than a happy side effect. A change to how Zips or tool cards behave has to be correct on all three paths, because all three feed the same renderer. Batshit treats that as the price of admission for "one experience, three runtimes" — and it's why these architecture pages keep coming back to parity as a theme.

One honest detail worth knowing: the `n8n` path doesn't always stream token-by-token the way a direct provider call can. n8n may finish the workflow and then hand Batshit the result, which Batshit replays through the same chat renderer. The output ends up in the same shape and the same UI; the live "typing" feel can just differ. Batshit doesn't pretend otherwise.

## Subagent lanes

A Subagent is a smaller specialist a Primary Agent can call when it needs focused help — a code reviewer, a researcher, a document drafter. You still talk to the Primary Agent; it decides when to delegate, hands off a task, gets a result, and keeps going. (For setup and pairing rules, see [Subagents](../subagents/overview.md).)

Mechanically, Subagents mirror the Primary Agent story: there are four launch lanes — an n8n subnode inside a workflow, a separate n8n workflow, a Batshit-managed `API` run, and a Batshit-managed `CLI` run — and they *reach their model differently*, just like Primary Agents do. But three things stay constant across all four:

- **They compile the same way.** Every Subagent's instructions are assembled from the same layers — its base instructions, the system prompt you wrote for it, optionally your global prompt, plus a small runtime context block — regardless of which lane runs it.
- **They run as non-streaming tool calls.** A Subagent doesn't take over the chat with a live character-by-character stream. The Primary Agent calls it like a tool, waits for the finished result, and stays responsible for the visible answer. You typically see a call card or a summarized result, not a second agent talking over the first.
- **They inherit only the parent's Project path.** A Subagent picks up the conversation's current Project so it's working in the right place — but it does *not* inherit the Primary Agent's full tool setup. Each Subagent carries its own tool permissions. That keeps a specialist's reach easy to reason about instead of silently as broad as whatever called it.

So the pattern is the same as Primary Agents one level down: same compilation, same workspace inheritance, different route to the model.

## Why this matters to you

The single most useful thing to take from all of this: **the runtime is a choice about where the model lives and what it can reach — not a measure of how good the answer will be.** None of the three is the "premium" tier. They're peers, tuned for different shapes of work.

That choice does have real downstream effects, and two of them connect to other parts of this section:

- **Caching.** Because the `API` path is Batshit talking directly to a provider, it's the path Batshit can shape to be cache-friendly — keeping the stable parts of a request at the front so a provider can reuse them. That can make repeated `API` sends cheaper. The other runtimes have their own caching behavior living in n8n or the CLI itself. See [Context, caching, and token optimization](context-caching-tokens.md).
- **Streaming and recovery.** Because all three converge on one event contract, the way Batshit shows live output, recovers from a failed or interrupted run, and exposes what was actually sent through the Execution Viewer works consistently across runtimes — even where the underlying streaming behavior differs. See [Streaming, recovery, and transparency](streaming-and-recovery.md).

A common, comfortable setup is one `API` agent for general work, one `CLI` agent for code, and an `n8n` agent for workflow-first automation — each pointed at the runtime that suits it, all sharing the exact same workspace. Pick by fit, not by an imagined ranking.

## Related

- [Primary Agents](../primary-agents/overview.md) · [Subagents](../subagents/overview.md)
- [Context, caching, and token optimization](context-caching-tokens.md)
- [Streaming, recovery, and transparency](streaming-and-recovery.md)
- [How Batshit works](overview.md)
