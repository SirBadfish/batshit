# Context, caching, and token optimization

Batshit is built so the stable parts of a conversation stay reusable, bulky output gets compressed before a provider ever sees it, and you can check the cache evidence instead of taking it on faith. This page explains how that works and, just as important, what it does not promise.

## Why request shape matters

Every model call re-sends context. The model has no memory between calls, so each turn ships the system prompt, the tools, and the conversation so far. Two things make that expensive:

- **Metadata bloat.** Many chat apps wrap every message in hundreds of tokens of timestamps, IDs, and model config. Over a long conversation that's thousands of tokens of pure overhead nobody re-reads.
- **Dragging everything along.** Long logs, diffs, and tool results get carried through the whole conversation even when they're done being useful.

There's a second, less obvious lever: **provider prompt caching rewards stable, repeated prefixes.** If the beginning of your request is identical to last time, a provider that supports caching can reuse that work cheaply. So the *order* of a request matters as much as its size — the more of the front that stays byte-for-byte stable, the more there is to reuse.

## The layered context model

Batshit assembles an `API` Primary Agent request from most stable to most volatile, on purpose:

1. **Stable setup first** — the base agent prompt, agent and user policies, the compact native-tool guidance, and the deterministic native tool schemas. These don't change from one of your messages to the next.
2. **Semi-stable next** — agent settings, project context, and the conversation history so far.
3. **Volatile last** — your newest message, the Dynamic Current Message (Batshit's per-send context block), the current Clip and Zip state, interruption notes, and anything that's true only for this one send.

Putting the churn at the end means everything in front of it can stay reusable. Stable policy settings (like default Zip behavior) live in the stable region; genuinely per-send state (like "these exact Zips are open right now") stays at the volatile tail, where it belongs.

## Batshit's own optimization comes first

Before any provider caching enters the picture, Batshit already shrinks what it sends:

- **Compact message storage.** Batshit doesn't wrap each message in metadata. A short message costs a few tokens, not a few hundred.
- **Zips.** Large tool output and long results are compressed to small references; the model only carries the full content when it's actually needed. See [Zips](../tools/zips.md).
- **Clips.** Files and images are stored once and referenced, and images reach the model as structured image input — never as raw bytes pasted into prompt text. See [Clips](../clips/overview.md).
- **Dynamic Tool Search.** Only a small, stable set of native tools is described in every request. Every other tool — MCP, CLI Tools, Artifacts, Fabric — is discovered on demand through a search-and-use contract, so thousands of tokens of tool schemas don't ride along on every message. See [Tools](../tools/overview.md).

These are why a Batshit request is already smaller and steadier before caching does anything.

## Provider caching builds on the stable prefix

Once the front of a request is genuinely stable, providers that support prompt caching can reuse it. Batshit makes `API` Primary Agent requests cache-friendly by default and adds the right provider-specific decoration at the transport edge — you don't hand-fill provider fields:

- **OpenAI** caches automatically on recent models. Batshit attaches a stable cache key so repeated sends route to the same cached prefix.
- **Anthropic** uses an explicit cache marker. Batshit places it on the stable system block, so the first eligible send writes the cache and later sends read it.
- **Gemini** caches implicitly on recent models once the stable prefix is large enough. Batshit keeps the prefix in the right order and reads the cache-hit counts back into its own usage numbers.
- **OpenRouter** keeps a conversation on the same provider endpoint (sticky routing) and passes per-message cache markers where the underlying provider needs them.
- **Vercel AI Gateway** can cache automatically; Batshit turns that on for gateway-routed models and leaves implicit-cache providers alone.

Gemini deserves one extra note: Batshit intentionally does **not** use Google's explicit `cachedContent` API for normal API agents right now. Google's explicit cache is a named, mostly frozen resource that must be created ahead of time, and current Google behavior rejects a `cachedContent` request if the live model call also sends system instructions, tools, or tool config. Batshit API agents normally keep tools enabled, so using that API would mean building a special Google-only transport that moves tool declarations into the cached resource without breaking tool execution. Until Google improves that contract, Batshit uses Gemini's implicit caching and shows whatever cache-token evidence Google reports.

Existing per-model cache settings still work as advanced overrides, but the default path is cache-friendly without manual setup.

## Honest caveats

Caching is a provider behavior, not a Batshit guarantee:

- **Short prompts may never hit a cache.** Providers have minimum token thresholds, and caches expire — often after a few minutes, sometimes an hour.
- **Image turns can change provider cache behavior.** Batshit keeps Clips out of prompt text and reuses stable image references where possible, but some providers may still miss or shrink cache reads when images are attached.
- **Not every model reports cache numbers,** and what's reported differs by provider.
- **Batshit never silently falls back.** If a provider rejects a cache option, you get a clear error — not a quiet uncached retry pretending optimization happened.

So the honest version of the claim is: Batshit is shaped so the stable parts of your context stay reusable, and it shows you the evidence where providers report it. It does **not** promise that every chat is cached.

## Seeing the evidence

The [Execution Viewer](../chat/execution-viewer.md) shows, in plain terms, what was actually sent and how a run used cache — cached input tokens read, and cache tokens created on the first eligible send — for the providers that report it. That's how you confirm caching is working on your own setup instead of trusting a marketing line.

## Related

- [Zips](../tools/zips.md) · [Clips](../clips/overview.md) · [Tools](../tools/overview.md)
- [Tools without prompt bloat](tools-without-bloat.md)
- [Streaming, recovery, and transparency](streaming-and-recovery.md)
- [Execution Viewer](../chat/execution-viewer.md)
