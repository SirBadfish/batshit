# Provider Prompt Caching

Most AI providers can reuse the unchanged start of your conversation between messages — the system prompt, the tool list, the earlier turns — instead of re-processing it from scratch. That reuse is called **prompt caching**, and on most providers cached input is billed at a steep discount (often 50–90% off). On a long chat, that is real money.

Batshit treats caching as a first-class concern: we send every routing and caching hint each provider officially documents, we show you honest cache numbers in the [Token Panel](../chat/overview.md#the-token-panel-your-context-meter), and we have live-tested every supported provider ourselves.

## What Batshit sends for you

You don't configure any of this — it's automatic per provider, and manual provider options you set are always preserved:

- **OpenAI (direct):** a stable prompt cache key derived from your agent and prompt shape, plus support for OpenAI's documented cache-retention options where the model allows them.
- **Anthropic (direct):** a cache breakpoint on your stable system prompt, exactly as Anthropic documents.
- **OpenRouter:** a stable per-session routing id, usage accounting, and Anthropic-style cache control for Claude-family models routed through it.
- **Vercel AI Gateway:** automatic caching mode, plus honest accounting — the gateway reports Anthropic-style raw token counts, and Batshit normalizes them so your Token Panel math is correct.
- **xAI:** the documented `x-grok-conv-id` conversation header, stable per session. In our testing this took xAI from never crediting reuse to crediting 88% of input on repeat sends.
- **Baseten and Fireworks:** the documented `x-session-affinity` header, stable per session, so related requests can land on the same server.
- **Everywhere:** the header values are anonymous hashes. Your real session and account identifiers never go to the provider.

## How we tested

Numbers on this page come from our own measurements (August 2026), not provider marketing:

- Repeated identical and prefix-identical long prompts (roughly 6,000–13,000 tokens) sent through Batshit's **real send path**, plus direct API probes outside the app for isolation — back-to-back, with tool definitions, and with 45-second gaps.
- Batshit's built-in opt-in **cache forensics** mode (`BATSHIT_CACHE_FORENSICS=1`), which fingerprints every segment of every outgoing request and records the provider's own cache counters per model call, with optional trace export to a local [Langfuse](https://langfuse.com) instance.
- Every verdict comes from **provider-reported token counts, never from response speed**. Where a provider credited nothing, we retried across sizes, pacing, and request shapes before writing it down.

## The report card (measured August 2026)

| Provider | What we measured | Notes |
|---|---|---|
| Anthropic | Excellent — textbook cache writes and reads (≈88% of input on repeats), persists across sessions | Best-in-class behavior |
| OpenAI | Excellent — ≈77% credited on repeats | |
| Google Gemini | Works in real chats (≈70%) | Google's cache needs a large prompt before it starts crediting — short test prompts show zero by design |
| Alibaba Cloud (Qwen) | Works — ≈67–70% verified in live Batshit use | Automatic; cached input billed at 20% of normal |
| Vercel AI Gateway | Works (≈84%) with honest Token Panel numbers | |
| xAI | Works with Batshit's conversation header — credits are real (up to ≈88% measured) but come and go with xAI's routing | Without the header it never credited reuse; some sends credit only xAI's 128-token floor |
| OpenRouter | Works (≈92% measured in full conversations) | With Batshit's session routing id |
| DeepSeek | Works (≈88%, warms up on the second repeat) | |
| DeepInfra | Works (≈86%) | |
| Moonshot (Kimi) | Works (≈85%) | |
| Z.ai (GLM) | Works (≈89%) | |
| MiMo | Works (≈74%) | |
| Together | Works (≈64% through Batshit in real conversations; ~100% on direct repeats) | Only models with a cached-input price credit; check their pricing table |
| Fireworks | Works (≈52% through Batshit in real conversations; ~100% on direct repeats) | Serverless discount applies automatically |
| Groq | Works, hit-or-miss by design (94% when it lands) | Their three GPT-OSS models only; Groq itself says hits aren't guaranteed, and the counter is simply absent on misses |
| MiniMax | Caches on their side (~100% on direct repeats) but hits through app traffic are unreliable | Their standard API documents no routing hint an app could send; the counter also shows a constant 128 on misses |
| Baseten | Caches only across rapid back-to-back requests | In our tests the reuse window was shorter than 45 seconds — slower-paced chats miss |
| Cerebras | Sends fine; caching is latency-only | Cerebras applies **no price discount** for cached tokens |
| Mistral | No cache reporting at all | Their API returns no cache fields, so nothing can be shown |
| Cohere | Reports a counter, but it read a constant 144 even on first messages in our tests | Treat it as noise; Cohere documents no cache pricing |

Local AI runtimes (Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner) are not in the table: you run those yourself, so there is no per-token bill and no provider cache counter to audit.

## Reading your own numbers

The Token Panel under the chat shows the cache hit rate for the latest response and, on hover, the whole chat. Two honesty rules to keep in mind:

- A dash means the provider reported nothing — Batshit never guesses.
- A tiny, constant cached number that never changes (like 128 or 144, even on a first message) is a provider-side counting quirk, not savings. Real reuse shows up as a large share of input that drops when the start of the conversation changes.

## Related docs

- [Chat overview — the Token Panel](../chat/overview.md#the-token-panel-your-context-meter)
- [Execution Viewer](../chat/execution-viewer.md)
- [Zips and context](../tools/zips.md)
