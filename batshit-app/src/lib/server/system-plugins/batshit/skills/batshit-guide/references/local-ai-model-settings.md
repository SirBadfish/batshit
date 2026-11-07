# Getting your local model settings right

When you run a model on your own computer, two things have opinions about how it should behave: the program running the model, and Batshit. This page explains exactly who wins, what Batshit sends, and what stays out of Batshit's hands entirely.

Short version: **most blank fields let your program decide. If you fill one in, that value wins for that message.** Ollama's **Thinking** is an exception: blank displays **Default (off)** and Batshit requests thinking off unless Custom Parameters override it.

## Blank means blank

Open a Model Preset for a local model and the settings section starts collapsed, with a header that names your program:

```text
Managed by LM Studio. Expand to override (optional).
```

Expand it and fields such as temperature are empty, with a placeholder that says **"Not sent — LM Studio decides"**. That is literal for those fields: a blank field is left out of the request entirely — Batshit does not quietly substitute a number. Ollama's Thinking choice instead says **Default (off)**; choose `true` to request thinking.

Three things to know:

- **Zero is a real value.** `0` means "send zero", not "blank". Clear the box if you want the field left out.
- **Filling a field overrides your program's default for that message only.** It does not change your program's saved settings.
- **Your existing presets are unchanged**, because they all carry values you can see. The one exception is below.

**Check older presets with an empty Max output tokens field.** Older Batshit versions applied a 16,384 cap when this field was empty. A blank field leaves the cap to your program. If you need that limit, enter `16384` explicitly.

### Why keep the fields at all?

Because "let the program decide" only works if the program has a place to decide. LM Studio and oMLX have settings screens. llama.cpp, vLLM, and SGLang use startup flags for these settings. KoboldCpp also has a launcher and native saved settings files; changing its loaded allocation still requires a restart.

There is also a second reason: **one model, several agents.** If a coding agent wants temperature 0.2 and a roleplay agent wants 0.9 on the same loaded model, only a per-message value can do that. Your program's default is one number for everybody.

## What each program actually accepts

Batshit offers settings supported by each program:

| Program | What you get beyond the basics |
| --- | --- |
| LM Studio | Top K, Min P, Repeat penalty, Auto unload after, Thinking effort |
| llama.cpp | Top K, Min P, Typical P, Repeat penalty and window, DRY, XTC, Mirostat |
| Docker Model Runner | Same as llama.cpp — it runs the llama.cpp engine |
| vLLM | Top K, Min P, Repetition penalty, Chat template options |
| SGLang | Top K, Min P, Repetition penalty, Chat template options |
| oMLX | Top K, Min P, Repetition penalty and window, Chat template options |
| KoboldCpp | The widest set here: repeat penalty and its range and slope, Top A, Tail-free, N-sigma, DRY, XTC, DynaTemp, Smoothing, Adaptive target, a drag-to-reorder sampler order, phrase bans, token bans, logit bias, negative prompts, Thinking effort and budget, and Chat template options |
| Ollama | Top K, Min P, Repeat penalty and window, Context size, Thinking |

Every program also gets the basics it accepts: temperature, Top P, max output tokens, the penalties, stop sequences, and seed.

**Custom Parameters work on local models.** If your program accepts a field Batshit doesn't offer, add it as a Custom Parameter and it goes straight into the request.

### Spelling matters, per program

**KoboldCpp can accept settings it ignores without warning.** A successful request does not mean every Custom Parameter had an effect. Two settings are not offered:

- **Mirostat is not offered in Batshit’s KoboldCpp presets.**
- **Frequency penalty is not offered.** KoboldCpp writes it into the same setting as Presence
  Penalty, so two boxes would fight over one value. You get Presence Penalty.

**KoboldCpp has 38 settings**, the most of any program here. The specialist ones live in their
own **KoboldCpp Options** section, and the two thinking limits in **Reasoning**, so Common stays
short.

A few worth knowing:

- **Sampler order** is a drag list. Leave it alone and KoboldCpp uses its own order. Click
  *Customise Order* to start from that default and drag from there; *Reset* puts it back to "not
  sent". Order only matters when more than one sampler is actually doing something.
- **Phrase bans** takes one phrase per line. This is the one that kills stock phrases a model leans
  on. KoboldCpp allows up to 768.
- **Negative prompt** and **Guidance strength** only work if you started KoboldCpp with
  `--enableguidance`, and they cost speed.
- **Never stop on its own** makes the model keep writing until Max output tokens runs out. Good for
  forcing a longer scene.

**Adaptive decay** and KoboldCpp's `max_context_length` request extension are **not offered in Batshit presets**. The request extension can reduce the
per-request processing buffer, but it cannot enlarge the context allocation made at startup.
Batshit does not expose or send it from a preset; raise KoboldCpp's loaded ceiling by restarting it
with a larger `--contextsize`, use the enrolled Local AI context editor, or apply an operator-prepared saved settings file containing that allocation.

Some programs call the same idea by a different name, and they ignore the other spelling without complaining. LM Studio wants `repeat_penalty` and ignores `repetition_penalty`; oMLX, vLLM, and SGLang want `repetition_penalty`. Batshit already picks the right one for you — this only matters if you're adding a Custom Parameter by hand.

## Changing KoboldCpp's loaded model or context

A Model Preset controls a message's settings. Changing KoboldCpp's loaded model or context requires restarting its model process.

On an explicitly enrolled **same-machine Mac installation**, **Settings → Local AI → KoboldCpp → Models** offers a real **Model** dropdown and **Context Tokens**. Enable the registered local setup once, choose an installed model, enter a whole number such as `60000`, confirm all chats are idle, and click **Apply and Restart**. The supported input range is 256 to 524,288 tokens; a particular model and context still need to fit your computer's memory.

**Leave KoboldCpp and its Terminal window running.** The checkbox means: **“No chats in any app using this KoboldCpp server are generating or waiting for a response.”** Wait for every client to finish, including queued requests. Restart affects all apps sharing the server and clears its context cache. Another client can still start a request after the idle check.

Local editing requires an operator to enroll the exact authorized directory and an installed GGUF with its complete nonsecret settings. Batshit privately pins that model's full base and writes a separate context-only override. It refuses changed directories, models or bases rather than choosing defaults. The browser never supplies a filesystem path or configuration JSON. A saved connection or loopback address alone does not grant file access.

While the registered setup is active, use **Apply and Restart** for model/context changes. Direct file loads and the defaults selector are unavailable, so they cannot discard the enrolled settings. An invalid active registration blocks changes and explains what failed. If the program uses a custom model name, **Unload Current Model** releases the model it is currently serving without guessing which file loaded it.

Without this enrollment, including remote and Docker connections, **Saved KoboldCpp Settings** remains available with protected single-model admin access. Choose an operator-prepared `.kcpps` or `.kcppt` and enter **Expected Served Model** and **Expected Real Context (tokens)**. Those expected fields only check the result; they do not edit the file or request a new allocation. Batshit explains when the local editor is unavailable.

Batshit rechecks the saved connection, loaded model/context, global idle/queue state and both exact base/override references before requesting restart. It waits up to three minutes for replacement-process evidence and reports the actual served model/context. A wrong allocation stays visibly failed. A lost answer stays uncertain, without automatic retry or rollback. KoboldCpp may recover its startup settings after a failed load, so matching model/context does not prove every enrolled setting applied; full-profile application remains unverified. Another action, or deletion of the saved connection, is blocked while the previous restart remains unresolved.

A backup carries the desired model/context as preferences, with context editing inactive after restore. Enroll the local setup again before enabling it. Restoring an older backup or removing and re-adding the connection cannot reactivate its previous grant. Removing the connection revokes retained local editing grants first. Managed files are retained because Batshit cannot prove that KoboldCpp will never reference them again; they are outside portable backups, alongside the external model weights.

Use a unique local admin password and enter the matching key in **Settings → API Keys → Local AI → KoboldCpp**. KoboldCpp startup output can print that password, and its launcher **Save Config** can write credentials in plain text. Do not share unredacted output or save a config after entering credentials. Batshit stores its own copy encrypted.

<a id="ollama-used-to-be-the-odd-one-out"></a>

## Ollama settings

**Ollama presets offer Top K, Min P, repeat penalty, the repeat window and Context size.**

Two settings are not offered:

- **Mirostat** is not available in Batshit’s Ollama presets.
- **Typical P** is not available in Ollama presets. Batshit ignores it even if you add it as a Custom Parameter.

The one thing still worth a **Modelfile**: a short recipe you write, then bake into a new model name. It isn't a file sitting on your disk waiting to be edited — `ollama show --modelfile` prints the recipe for a model you already pulled so you can copy and change it.

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

**Ollama chooses a context size based on its defaults and available memory**, not simply the model card's maximum. When a conversation grows past that size, **Ollama can drop the beginning of it and answer anyway.** No error, no warning, nothing in the response to tell you it happened.

So a model card that says 131k, on a 16 GiB laptop, is really 4k — and past that point your agent silently forgets the start of every conversation.

Batshit reads the allocation from Ollama while the model is loaded. Its planning budget uses that size, capped by a smaller positive **Context window** in your preset.
If Ollama has no loaded-context reading yet, Batshit marks the denominator unknown instead of
substituting the model's advertised maximum or the preset.

**Set it with Context size in the Ollama preset.** Leave it blank
to let Ollama use its current/default context policy, or put a number in it and Batshit requests
that size for the message. That requested allocation replaces any older loaded reading. A smaller
positive **Context window** still caps Batshit's planning budget; it does not change the Context size
value sent to Ollama.

One thing to know: changing it makes Ollama **reload the model**. That takes a moment, and it throws
away Ollama's memory of your earlier prompts, so the next reply is slower. Set it once and leave it;
don't change it between chats.

If you would rather not set it per preset, there are still two other ways:

- **For one model**, add `PARAMETER num_ctx 32768` to a Modelfile using the three commands above.
- **For everything**, start Ollama with the size you want:

  ```bash
  OLLAMA_CONTEXT_LENGTH=32768 ollama serve
  ```

Bigger contexts use more memory. If Ollama starts refusing to load a model after you raise it, that's why.

## What your program owns, and Batshit never touches

Some of the most important settings for local models are decided when the model **loads**, not when you send a message. Batshit does not change these settings from a preset. Ollama's Context size field is a specific exception: it sends a per-request `num_ctx` value, which can make Ollama reload the model at that size. KoboldCpp's preset context value does not change its startup allocation.

- **Context size** — how much conversation fits (see above)
- **GPU offload** — how much of the model sits on your graphics card
- **Flash attention** and **KV cache quantization** — memory and speed tuning
- **Speculative decoding** and **MTP** — techniques that produce tokens faster
- **Which quantization you downloaded** — 4-bit, 8-bit, and so on

Set these in LM Studio's load settings, oMLX's model panel, or your llama.cpp / vLLM / SGLang launch flags. They change how tokens get produced, not the shape of the request, so they're invisible to Batshit — and that's the correct arrangement.

## LM Studio adds its own instructions to your prompt

**LM Studio 0.4.23 puts its own paragraph at the very front of the system message on every API request** — including when the request contains no system message at all. It reads something like:

```text
Reasoning effort is set to xhigh. Please think carefully through the task, validate key
assumptions, consider plausible alternatives, and prioritize correctness…
```

So Batshit's carefully assembled prompt is **not** the first thing the model reads. LM Studio's text is.

Two practical consequences:

- **Set Thinking effort in your preset and the paragraph disappears**, and the model then sees Batshit's prompt first. Setting it to "None" also stops the model thinking at all, which is a big speed win on a model that doesn't need to.
- **Changing Thinking effort mid-conversation is expensive.** It rewrites the bytes at the very start of your prompt, which throws away LM Studio's whole cached prefix. Your next message will be slow again. Pick a level and stay on it. ([Why that matters](speed-and-caching.md).)

In LM Studio 0.4.23, the system prompt box applies to conversations in its Chat tab; it does not reach the API server.

## Thinking effort, per program

Only some programs accept a thinking level per message, and they disagree about the words.

- **LM Studio** accepts `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Worth knowing: LM Studio's *model information* advertises a different list including `off` and `on`, and the server rejects both. Batshit offers the six that actually work.
- **Ollama** has a **Thinking** choice of `true` or `false`, shown only when the preset supports reasoning. Batshit reads reported Vision and Reasoning support from Ollama for the exact model. Opening the preset or refreshing the catalog can reveal the field without changing your saved settings; any explicit support restrictions you saved stay in place. If Ollama does not report usable support, Batshit leaves it unknown instead of guessing from the model name. Thinking stays blank until you choose a value and displays **Default (off)**: Batshit requests thinking off by default, rather than leaving it to Ollama. Choose `true` to request thinking or `false` to request it off explicitly. Custom Parameters named `think` or `ollama.think` can override this choice, including its blank default. Tools stay off for local presets unless you enable them yourself. Turning Thinking on for an unsupported model fails the message rather than being ignored.
- **KoboldCpp** turns Thinking effort into a limit on how long the model thinks: None, Minimal, Low, Medium, and High allow 0%, 10%, 25%, 50%, and 75% of Max output tokens. When the model reaches it, KoboldCpp ends the thinking, adds a short "(Reasoning budget exceeded)" note to it, and the model answers. **Thinking budget** does the same with an exact number of tokens. If you set both, Thinking effort wins. There is no Extra high here: KoboldCpp treats any other word as "no limit". Both do nothing on a model that doesn't think, so they are safe to leave set.
- **vLLM, SGLang, oMLX, and KoboldCpp** switch thinking on or off through **Chat template options**. KoboldCpp only reads it when you started it with `--jinja`. The usual one is:

  ```json
  {"enable_thinking": false}
  ```

**Whether a model thinks at all can depend on the file you downloaded.** Qwen's own Qwen3.5 thinks by default. The popular unsloth GGUF of the same model has thinking switched **off** by default. If your model never thinks, try `{"enable_thinking": true}`.

## Model formats, and why Mac users care

Where your program tells us, Batshit shows the model's **format** as a small tag in the preset editor — usually `gguf` or `mlx`. LM Studio reports it; most others don't, and then no tag appears.

The tag is shown exactly as the program words it. There are more than two formats in the world and new ones appear, so Batshit never guesses or forces an unfamiliar value into a box it doesn't fit.

**On Apple Silicon the format is a real choice.** MLX is Apple's own machine-learning framework, built for the unified memory and GPU in M-series chips. GGUF is the widely-used cross-platform format that llama.cpp and Ollama are built around. On the same Mac and the same model, an MLX build commonly runs meaningfully faster than the GGUF equivalent.

The speed difference depends on your chip, the model, and the quantization.

**One MLX download can serve two programs.** Point [oMLX](sglang-and-omlx.md) at LM Studio's model folder and both list the same model, so you don't store it twice. If you're on an Apple Silicon Mac and choosing between two builds of the same model, MLX is usually the one to try first.

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
