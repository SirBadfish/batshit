# Getting your local model settings right

When you run a model on your own computer, two things have opinions about how it should behave: the program running the model, and Batshit. This page explains exactly who wins, what Batshit sends, and what stays out of Batshit's hands entirely.

Short version: **if you leave a field blank in Batshit, Batshit sends nothing for it and your program decides. If you fill it in, that value wins for that message.** Everything below is the detail behind those two sentences.

## Blank means blank

Open a Model Preset for a local model and the settings section starts collapsed, with a header that names your program:

```text
Managed by LM Studio. Expand to override (optional).
```

Expand it and every field is empty, with a placeholder that says **"Not sent — LM Studio decides"**. That is literal. A blank field is left out of the request entirely — Batshit does not quietly substitute a number.

This used to be untrue. Batshit forced `temperature: 0.7` and a 16,384 output cap onto every request, even when you had set neither, and clearing the temperature box just refilled itself. If a model's author told you "use temperature 0.6 and don't set Top P", Batshit could not follow that. Now it can.

Three things to know:

- **Zero is a real value.** `0` means "send zero", not "blank". Clear the box if you want the field left out.
- **Filling a field overrides your program's default for that message only.** It does not change your program's saved settings.
- **Your existing presets are unchanged**, because they all carry values you can see. The one exception is below.

**One behavior change to know about.** If a preset had **Max output tokens** left empty, it used to silently receive a 16,384 cap. It now sends no cap at all, and your program decides. If you were relying on that hidden cap, type the number you want into the field.

### Why keep the fields at all?

Because "let the program decide" only works if the program has a place to decide. LM Studio and oMLX have settings screens. llama.cpp, vLLM, and SGLang do not — their settings are command-line flags you chose when you started the server, and changing one means restarting it.

There is also a second reason: **one model, several agents.** If a coding agent wants temperature 0.2 and a roleplay agent wants 0.9 on the same loaded model, only a per-message value can do that. Your program's default is one number for everybody.

## What each program actually accepts

Batshit now offers each program only the settings it genuinely uses, and every one it offers reaches the model. Nothing is shown and then thrown away.

That sounds obvious. It was not true before: Batshit offered **Top K** on every local model and then dropped it before the request left, because of a limitation in the library underneath. Meanwhile `min_p` and the repetition controls that local model authors actually recommend had no field at all.

| Program | What you get beyond the basics |
| --- | --- |
| LM Studio | Top K, Min P, Repeat penalty, Auto unload after, Thinking effort |
| llama.cpp | Top K, Min P, Typical P, Repeat penalty and window, DRY, XTC, Mirostat |
| Docker Model Runner | Same as llama.cpp — it runs the llama.cpp engine |
| vLLM | Top K, Min P, Repetition penalty, Chat template options |
| SGLang | Top K, Min P, Repetition penalty, Chat template options |
| oMLX | Top K, Min P, Repetition penalty and window, Chat template options |
| Ollama | Thinking effort only — see below |

Every program also gets the basics it accepts: temperature, Top P, max output tokens, the penalties, stop sequences, and seed.

**Custom Parameters now work on local models.** If your program accepts a field Batshit doesn't offer, add it as a Custom Parameter and it goes straight into the request. Before, that was a silent no-op on every local model.

### Spelling matters, per program

Some programs call the same idea by a different name, and they ignore the other spelling without complaining. LM Studio wants `repeat_penalty` and ignores `repetition_penalty`; oMLX, vLLM, and SGLang want `repetition_penalty`. Batshit already picks the right one for you — this only matters if you're adding a Custom Parameter by hand.

## Ollama is the odd one out

Ollama's OpenAI-compatible endpoint accepts the smallest set of any program here, and — this is the part that catches people — **it ignores anything it doesn't recognize without saying a word.** Send it `top_k` and you get a normal successful response with `top_k` quietly discarded.

So Batshit doesn't offer them. Showing you a Top K box that does nothing would be a lie.

The settings Ollama can genuinely use live in a **Modelfile**: a short recipe you write, then bake into a new model name. It isn't a file sitting on your disk waiting to be edited — `ollama show --modelfile` prints the recipe for a model you already pulled so you can copy and change it.

Batshit shows you the exact commands, already filled in with your model's name, right in the preset editor. They look like this:

```bash
ollama show --modelfile llama3.2:latest > Modelfile
```

Open the new `Modelfile` and add the line you want, for example:

```text
PARAMETER top_k 40
```

Then bake it into a new model:

```bash
ollama create llama3.2-custom -f Modelfile
```

Select `llama3.2-custom` in Batshit and your setting is in effect. Ollama's own [Modelfile reference](https://docs.ollama.com/modelfile) lists everything you can put in there.

### The Ollama context trap

This one is worth reading twice, because it fails silently and it can make a long conversation quietly worse.

**Ollama picks its context size from how much memory your computer has**, not from what the model can do. Roughly: 4k below 24 GiB of RAM, 32k from 24 to 48 GiB, 256k above that, capped at the model's own limit. And when a conversation grows past that size, **Ollama drops the beginning of it and answers anyway.** No error, no warning, nothing in the response to tell you it happened.

So a model card that says 131k, on a 16 GiB laptop, is really 4k — and past that point your agent silently forgets the start of every conversation.

Batshit now reads the real number from Ollama while the model is loaded and plans against that instead. But **Batshit cannot set it** — the OpenAI-compatible endpoint has no field for context size. Two ways to change it yourself:

- **For one model**, add `PARAMETER num_ctx 32768` to a Modelfile using the three commands above.
- **For everything**, start Ollama with the size you want:

  ```bash
  OLLAMA_CONTEXT_LENGTH=32768 ollama serve
  ```

Bigger contexts use more memory. If Ollama starts refusing to load a model after you raise it, that's why.

## What your program owns, and Batshit never touches

Some of the most important settings for local models are decided when the model **loads**, not when you send a message. There is no way to express them in a request, in any program, from any client. Batshit doesn't interfere with them and couldn't if it tried:

- **Context size** — how much conversation fits (see above)
- **GPU offload** — how much of the model sits on your graphics card
- **Flash attention** and **KV cache quantization** — memory and speed tuning
- **Speculative decoding** and **MTP** — techniques that produce tokens faster
- **Which quantization you downloaded** — 4-bit, 8-bit, and so on

Set these in LM Studio's load settings, oMLX's model panel, or your llama.cpp / vLLM / SGLang launch flags. They change how tokens get produced, not the shape of the request, so they're invisible to Batshit — and that's the correct arrangement.

## LM Studio adds its own instructions to your prompt

We measured this rather than guessing, and the answer surprised us.

**LM Studio puts its own paragraph at the very front of the system message on every API request** — including when the request contains no system message at all. It reads something like:

```text
Reasoning effort is set to xhigh. Please think carefully through the task, validate key
assumptions, consider plausible alternatives, and prioritize correctness…
```

So Batshit's carefully assembled prompt is **not** the first thing the model reads. LM Studio's text is.

Two practical consequences:

- **Set Thinking effort in your preset and the paragraph disappears**, and the model then sees Batshit's prompt first. Setting it to "None" also stops the model thinking at all, which is a big speed win on a model that doesn't need to.
- **Changing Thinking effort mid-conversation is expensive.** It rewrites the bytes at the very start of your prompt, which throws away LM Studio's whole cached prefix. Your next message will be slow again. Pick a level and stay on it. ([Why that matters](speed-and-caching.md).)

The narrower worry — that LM Studio's own system prompt box competes with Batshit's — measured **no**. That box is a per-conversation setting in LM Studio's Chat tab and it never reaches the server.

Measured on LM Studio 0.4.23.

## Thinking effort, per program

Only some programs accept a thinking level per message, and they disagree about the words.

- **LM Studio** accepts `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Worth knowing: LM Studio's *model information* advertises a different list including `off` and `on`, and the server rejects both. Batshit offers the six that actually work.
- **Ollama** accepts a thinking level, but **only on a model that can think.** Send it to a model that can't and Ollama fails the whole message with `"llama3.2:latest" does not support thinking` — it does not politely ignore it. Batshit only shows the field when your preset is marked as a reasoning model, and `none` is always safe.
- **vLLM, SGLang, and oMLX** toggle thinking through **Chat template options** instead. The usual one is:

  ```json
  {"enable_thinking": false}
  ```

## Model formats, and why Mac users care

Where your program tells us, Batshit shows the model's **format** as a small tag in the preset editor — usually `gguf` or `mlx`. LM Studio reports it; most others don't, and then no tag appears.

The tag is shown exactly as the program words it. There are more than two formats in the world and new ones appear, so Batshit never guesses or forces an unfamiliar value into a box it doesn't fit.

**On Apple Silicon the format is a real choice.** MLX is Apple's own machine-learning framework, built for the unified memory and GPU in M-series chips. GGUF is the widely-used cross-platform format that llama.cpp and Ollama are built around. On the same Mac and the same model, an MLX build commonly runs meaningfully faster than the GGUF equivalent.

We're not putting a number on that, because we haven't measured it ourselves and the honest answer depends on your chip, the model, and the quantization.

What we can tell you concretely: **one MLX download can serve two programs.** Point [oMLX](sglang-and-omlx.md) at LM Studio's model folder and both list the same model, so you don't store it twice. If you're on an Apple Silicon Mac and choosing between two builds of the same model, MLX is usually the one to try first.

## A sensible order to test in

1. Leave every field blank. Send a short message. Confirm you get a sane reply.
2. Set one thing — usually temperature — and confirm the reply changes character.
3. If your model's author recommends specific values, type those in and leave everything else blank.
4. Only then add samplers like Min P or a repetition control, one at a time.

If a setting seems to do nothing, check the table above: your program may simply not accept it. And if you're on Ollama, check whether it belongs in a Modelfile instead.

## Related docs

- [Local AI overview](overview.md) — connecting a program in the first place
- [Why your local model gets faster](speed-and-caching.md) — prompt caching and speed
- [SGLang and oMLX](sglang-and-omlx.md) — setting up the two newest programs
- [Model catalog](../providers/model-catalog.md) — how presets and models fit together
