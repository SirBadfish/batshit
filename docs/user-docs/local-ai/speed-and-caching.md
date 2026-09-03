# Why your local model gets faster on the second message

The first message in a chat takes forever. The second one comes back almost instantly. That's not luck and it's not warm-up — it's a prompt cache, and once you know how it works you can stop accidentally throwing it away.

## What's actually slow

Before a local model writes a single word, it has to read your entire prompt: the system prompt, the tool list, and every message so far. That reading step is called **prompt processing**, and on a home computer it is usually the slow part. The writing that follows is comparatively quick.

Every program here keeps a **prompt cache**: after it reads a prompt, it holds on to the processed result. Next message, if the *beginning* of your prompt is byte-for-byte identical, it skips straight past that part and only reads the new bit.

Three real measurements from the same Mac:

| Program | First message | Repeat |
| --- | --- | --- |
| Ollama, 2,100-token prompt | 27 s | 0.05 s |
| LM Studio, 2,100-token prompt | 51.6 s | 2.2 s |
| oMLX, 9,300-token prompt | 134.6 s | 18.6 s |

That is the same work, done once instead of twice. Nothing was configured to make it happen — every one of these programs caches by default.

## Batshit's job is to keep the start of your prompt still

A prefix cache only works while the front of the prompt doesn't move. One changed byte near the beginning and everything after it has to be re-read.

Batshit is built around that. The conversation is assembled most-stable-first: your agent's identity and instructions at the top, then history, then the things that genuinely change every message — your newest message, Clip and memory context, the current tool state. Those volatile pieces sit at the **end**, where changing them costs nothing.

The proof is measurable: on a real oMLX conversation, adding a whole new turn credited exactly the same cached amount as sending the identical message twice. The new turn landed at the end, so nothing before it moved.

You don't configure any of this. It's the same design that saves money on cloud providers, and on a local model it buys you time instead.

## What resets the cache, and what doesn't

**Safe — these do not reset it:**

- Changing temperature, Top K, Min P, or any other sampler. Those aren't part of the prompt at all. We tested it: LM Studio's repeat with different sampler values still came back in 2.2 s.
- Sending a longer message, or many more messages. The old part is still cached.
- Waiting a while, usually. oMLX even keeps its cache on disk across restarts.

**Expensive — these throw the cache away:**

- **Editing your agent's system prompt.** That's the very first thing in the request, so everything after it has to be re-read. Expected, and worth it when you mean to do it.
- **Changing Thinking effort on LM Studio.** LM Studio writes its own instruction paragraph at the front of the prompt, derived from the effort level. Change the level and those first bytes change. ([More on that.](model-settings.md#lm-studio-adds-its-own-instructions-to-your-prompt))
- **Overflowing the context window.** This is the sneaky one, below.

### Context overflow is a permanent slowdown

When a conversation grows past the context your model was loaded with, the program has to drop something. Ollama drops the oldest messages from the front. LM Studio's default is Truncate Middle, which cuts out the middle of the conversation.

Either way, **the beginning of the prompt is now different on every single message.** The cache misses forever, from that point on, and every message pays the full slow read again — on top of the content you silently lost.

That is why Batshit now reads the context your program is *actually* running with and plans against it, instead of trusting the model's advertised maximum. If Batshit shows an amber note in your preset saying your program is running the model smaller than the preset says, believe the program. See [Getting your settings right](model-settings.md#the-ollama-context-trap) for how to raise it.

## What the Token Panel can and can't tell you

Open the Token Panel under the chat and hover the cache figure. What you see depends on your program, and Batshit is deliberately honest about the difference between "nothing was cached" and "I can't see whether anything was cached".

| Your program | What you'll see |
| --- | --- |
| llama.cpp, Docker Model Runner, SGLang, oMLX | A real cached-token count and a hit percentage |
| Ollama, vLLM, LM Studio | A note saying that program doesn't report cache numbers |

Some programs simply don't put the number in their response. **Their caches still work** — Ollama went from 27 seconds to 0.05 seconds while reporting nothing at all. There is just no counter to read.

Batshit will not fake it. It won't show you a zero the program never sent, and it won't look at how fast the answer arrived and call that a cache hit. Speed and cache are two different pieces of evidence, and guessing one from the other is exactly how you end up confidently wrong. On Ollama the tooltip says so plainly:

> Ollama does not report cache numbers, so Batshit will not show one. Its cache is still working, and you can see it in the speed: a repeat answer starts much sooner than the first one did.

Which brings us to the number that always works.

## Watch the speed instead

Next to the cache figure, the Token Panel shows **time to first output** — how long you waited before the model started writing — and **tokens per second** once it got going.

Time to first output is the honest cache meter for every program, reporting or not. Send a message, note it. Send another, note it again. If the second one is dramatically lower, your cache is working.

That number is also how you spot a problem. If time to first output stops dropping on repeat messages and stays high, something is moving the front of your prompt. Check whether you edited the system prompt, changed Thinking effort, or ran out of context.

## Caches that work in blocks

One thing that looks like a bug and isn't.

**oMLX caches in blocks of 4,096 tokens.** A conversation shorter than one block honestly reports zero cached tokens — there isn't a whole block to reuse yet. The last partial block always gets re-read too.

You can watch it arrive in steps. On a real 14,000-token conversation the counts went `0 → 4,096 → 12,288`, exactly on the block boundaries, while time to first output fell from 217 seconds to 33.

So a zero on a short chat with a block-caching program is correct, not broken. Batshit explains this in the tooltip rather than leaving you to wonder. Keep talking and the number climbs.

## The short version

- Caching is on by default in every program here. You don't turn it on.
- It saves **time**, not money — you're not paying per token on your own hardware.
- Batshit already keeps the front of your prompt stable. That's the only part it controls.
- Fiddle with samplers freely. Think twice before editing the system prompt mid-chat.
- Don't let the conversation outgrow your context, or the cache misses forever.
- If your program doesn't report cache numbers, watch time to first output instead.

## Related docs

- [Getting your local model settings right](model-settings.md)
- [Local AI overview](overview.md)
- [Context, caching, and token optimization](../architecture/context-caching-tokens.md) — the same ideas for cloud providers
- [Provider prompt caching](../reference/provider-prompt-caching.md) — what each cloud provider does
