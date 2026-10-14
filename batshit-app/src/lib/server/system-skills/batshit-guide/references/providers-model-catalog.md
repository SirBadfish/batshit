# Model Catalog and Model Presets

The Model Catalog is Batshit's centralized list of AI models across every provider you can reach, and a Model Preset is a saved, reusable configuration that pins one model plus its settings so your agents don't have to repeat that setup. This page teaches both concepts and how they fit together. For adding the provider keys that unlock those models — and the step-by-step preset form — see [API keys and models](api-keys-and-models.md).

## What the Model Catalog is

Every AI provider has its own model list, its own names, and its own quirks. Without help, you'd be copy-pasting model IDs like `gpt-5.2` or `claude-sonnet-4-5` by hand and hoping you got them right.

The Model Catalog solves that. It's one combined, searchable list that pulls together:

- Hosted gateway models (Vercel AI Gateway, OpenRouter, and the providers they front).
- Direct provider models for providers you've connected — OpenAI, Anthropic, Google, xAI, Mistral, Groq, DeepSeek, Together.ai, Fireworks AI, Baseten, Cerebras, MiniMax, MiMo, Cohere, and more. Separate Kimi Code, MiniMax Token Plan, MiMo Token Plan, Qwen Token Plan, and Z.ai Coding Plan routes appear when those subscriptions use distinct credentials or endpoints.
- Your own [Local AI](../local-ai/overview.md) models, once a local program is enabled and reachable.

Instead of memorizing model IDs, you browse the catalog, filter to what you want, and let Batshit fill in the exact identifiers. It lives in Settings → Models, with a toggleable catalog viewer for browsing and searching the full normalized list.

The catalog's model-type filters are **Text**, **Vision**, **Media**, **Audio**, and **Utility**. Vision sits immediately after Text because it narrows the text models to those that can inspect images; Media covers image and video generation models. A vision-capable text model therefore appears under both Text and Vision. The same distinction applies to OCR: a chat model that can read text in images stays a Text model, while a dedicated OCR endpoint can be Utility. Open **View Details** on the selected model to see every capability the catalog reports, such as streaming, vision, tool calling, reasoning, cache control, and long context.

For connections that support an output-token setting, Batshit fills a trustworthy catalog max output limit into the preset. If the catalog does not provide that limit, or reports a value that would reserve nearly the whole context window for output, Batshit fills a conservative safe default instead. In that case the Max Output Tokens row shows an **Estimated** badge so you know the value is a Batshit default, not confirmed provider metadata. ChatGPT Plan manages its output limit and does not use this setting.

### ChatGPT plan models

In the local Mac app, connecting **ChatGPT Plan** in API Keys adds that account's own model list. It remains separate from paid OpenAI API models. A plan preset offers only the settings the plan supports; output limits are managed by ChatGPT and unspecified context limits stay unknown. The list never borrows another connection's prices or limits.

For exact models with verified OpenAI documentation, **View Details** shows image-input support and separately labeled published context/output ceilings, with the source link and verification date. These published ceilings do not establish your ChatGPT account's effective budget. A blank **Context Window** says **Unknown**; leave it blank unless you have verified your account's budget. Vision means the model can inspect an image Clip, not generate images. If an existing preset is explicitly saved as text-only, Batshit keeps that restriction in its display, save and runtime behavior. **Supported Features** describes the preset; the catalog describes the model. **Overwrite Selected Preset** explicitly reapplies the catalog features. Loading or refreshing never changes the saved restriction.

**Refresh** reloads the selected accounts' current model lists, preserving their names and order. A model listed in the paid OpenAI catalog may still be unavailable to your ChatGPT account. Published properties use a dated snapshot audited by Batshit's existing daily catalog maintenance; changed or unreadable documentation requires a reviewed update. Account Refresh does not imply that the published-property snapshot was reverified or updated. A new exact model without verified metadata keeps unknown capabilities and limits.

If the account disconnects or needs reconnecting, its presets stay saved but cannot run until you reconnect and choose the right connection. Switching accounts cannot resume an approval from the previous connection. See [ChatGPT plan setup](api-keys-and-models.md#connect-a-chatgpt-plan-in-the-mac-app).

## How a model gets named

Batshit describes every model with three parts, because "the OpenAI model on OpenRouter" and "the OpenAI model called directly" are not the same route even when it's the same model:

| Part | What it means | Example |
| --- | --- | --- |
| Provider / connection | The route and key Batshit uses to reach the model | `direct:anthropic`, `openrouter`, `vercel-gateway` |
| Developer | Batshit's canonical identity for the company that made the model | `openai`, `anthropic`, `zai` |
| Model ID | The developer's specific model | `gpt-5.2`, `claude-sonnet-4-5` |

The same model can show up on more than one route. A single catalog entry can advertise every transport it works with, so you pick the model first, then choose which connection carries it.

The provider may spell the developer namespace differently on each route. For example, one Z.ai model can use `zai/...` through one connection, `z-ai/...` through OpenRouter, and `zai-org/...` through DeepInfra. Batshit groups those reviewed aliases under one **Z.ai** developer in catalog filters and search, while preserving the exact request ID published by each provider, including capitalization such as DeepInfra's `Qwen/...`. It never rewrites a request ID from the combined catalog row. Moonshot works the same way: its own list says `moonshot` and the other routes say `moonshotai`, and both show as one **MoonshotAI** developer.

Qwen Cloud's model list names no maker at all, so Batshit reads the maker from the model ID: Qwen models under **Qwen**, `deepseek-...` under **DeepSeek**, `glm-...` under **Z.ai**, `kimi-...` under **MoonshotAI**, and Alibaba's own Wan, Z-Image, and embedding models under **Alibaba**. Kimi K3 on Qwen Cloud is then the same catalog entry as Kimi K3 everywhere else. The request ID stays exactly what Qwen Cloud listed.

This matters because the provider/connection is what decides which saved key gets used. A Google-made model reached through a gateway uses that gateway's key, not your direct Google key.

## How catalog content stays current

The catalog isn't a hardcoded list baked into the app. Batshit refreshes a shared model snapshot from a hosted registry and from live provider model lists, then merges in your local models on the fly.

A few honest notes:

- New models show up as providers add them. Missing models stay listed until a later successful recheck and provider evidence confirm retirement. A preset you saved is never deleted when its model leaves a list: if Vercel AI Gateway stops listing a preset's model, the preset and its settings stay, the model pickers show it as unavailable ("Vercel AI Gateway no longer lists this model"), and an agent that uses it cannot send until you pick another model for it. Settings → Models names those presets at the top of the tab.
- Every connection attached to a shared catalog row must include its own complete provider request ID. Batshit refuses to publish or save a catalog selection whose connection-specific identity is missing rather than trying a likely-looking name.
- If a provider's list is unreachable, incomplete, or rejects the registry's key, Batshit keeps its saved entries while the refresh is retried or investigated. A degraded refresh does not mean those models were deleted. Catalog presence does not guarantee that your own provider account can use every listed model.
- Models that Batshit cannot run through a particular connection are excluded by that connection's reviewed compatibility rules, even if an older catalog listed them. For example, OpenAI's legacy completions-only models are excluded from direct OpenAI; their supported routes through other providers can remain listed. This does not delete saved presets.
- Catalog freshness isn't instant. A model a provider added minutes ago may not appear until the next refresh.
- DeepInfra's active chat models come from its public model feed, so the shared catalog can stay current without putting your personal DeepInfra key in Batshit's Vercel project. Your saved key is still required locally when you actually send a message through DeepInfra.
- Together.ai, Fireworks AI, Baseten, Cerebras, MiniMax, MiMo, and Cohere use their provider-published model lists. Batshit preserves each connection's exact request ID, including developer prefixes and Fireworks' full `accounts/fireworks/models/...` names.
- Subscription connections with stable published rosters keep a docs-backed fallback even when Batshit's hosted sync cannot use your personal key. If a configured environment plan key exposes `/models`, Batshit merges that live list so newly advertised IDs can appear without deleting the reviewed fallback during an outage.
- Prices and context sizes follow the connection you pick. When a route lists its own price or context size for a model (OpenRouter, DeepInfra, Together.ai, and Anthropic's own list often differ from the gateway), a preset on that route takes that route's numbers, not another route's.
- A model the provider lists as free shows $0. A price nobody lists, such as OpenRouter's Auto Router (its price depends on the model it picks), shows **Unknown**, never a made-up $0. So does the per-token price of a transcription model the gateway sells by the second of audio, such as Whisper.
- A route that publishes no prices of its own never shows another route's price. A model maker's own API (OpenAI's for GPT, Anthropic's for Claude, and so on) shows the maker's list price, the same price Vercel AI Gateway charges. Any other route, such as Qwen Cloud serving Kimi or Replicate serving GPT, shows Artificial Analysis's price for the model, or **Unknown** when there is none.
- A flat-fee plan connection (Kimi Code, the Z.ai Coding Plan, and the MiniMax, MiMo, and Qwen token plans) shows **Token plan** instead of a price, because it bills one flat fee rather than charging per token.
- The Models tab keeps itself current while it is open. Saving a key, turning on a local program, or switching models on a Local AI model card updates it without a reload.

If a model you expect is missing, confirm the relevant provider key is saved and the connection shows Ready before assuming the catalog is broken.

### What Ready means

**Ready** describes the connection's local setup. For a hosted API provider, it means Batshit has a key for that route; it does not prove the provider will accept it or that your account can use every listed model. For Local AI, it means the program is enabled, so check that it is reachable too. A custom OpenAI-compatible provider also needs a non-empty saved key that Batshit can read.

If the Models tab reports a load error, use **Refresh** to try again. That error does not establish that a key or model was removed.

## What a Model Preset is

A Model Preset is a saved bundle: one model, on one connection, with its settings locked in and given a clear name. Once saved, any `API` agent can select that preset instead of re-choosing a provider, model, and a pile of options every time.

A preset captures things like:

- The provider connection, the stable catalog entry, and that provider's exact model request ID.
- Its preset category: Chat, Media, Audio, or Utility.
- Whether tools are enabled.
- Image transport, reasoning, and context settings where the model supports them.
- Pricing and other provider-specific options.

Give presets names you'll actually recognize:

- `OpenAI - GPT daily`
- `Anthropic - Writing`
- `Groq - Fast`
- `Ollama - Local`
- `OpenRouter - Long context`

Because a preset pins the connection too, you can save the same model more than once on different routes — direct versus gateway versus OpenRouter — without them colliding. That's useful when you want, say, a cheap gateway version for everyday chat and a direct-provider version for a specific agent.

To keep two presets of the same model on the same route, give them different display names. Batshit never lets a new preset replace one you already have: if a preset with that name already exists for that model and route, it says so, names the preset, and saves nothing, so you can change the display name and try again.

When you edit a preset, every agent that uses it sends the new values on its next message. A value you clear in the preset (a temperature, a reasoning setting, a custom parameter) is no longer sent at all, and switching an agent to another preset never carries over the old preset's values. A value of `0` is kept and sent. Picking another preset in the chat bar or in Agent Settings changes only the agent's model settings: its Bash access mode, its never-allow list, its command location, and its web search choice stay as they were. Agent Settings saves only what you change there, so a model or Bash access mode you picked in the chat bar of another window after Settings opened stays too, even when you then change the never-allow list, the command location, or the web search choice in that Settings window. The same goes the other way: picking a Bash access mode in the chat bar changes only the access mode (and the command location it needs), never the never-allow list or the web search choice you saved in Settings. A Settings window opened earlier still shows its older values until you reopen it.

### Reasoning from OpenAI-compatible models

Reasoning-capable models do not all send their thinking the same way. Some providers return a dedicated reasoning field, while models such as MiMo or some DeepSeek/open-model routes may place it inside `<think>...</think>` tags in the ordinary text stream.

For `API` agents, Batshit normalizes both formats into the same reasoning panel when the preset is marked reasoning-capable or the model/provider is a known MiMo or DeepSeek path. **Display Reasoning** controls whether that panel is shown. When it is on and the model emits reasoning, Batshit saves that reasoning with the message so it remains visible after refresh regardless of the Preserve setting. **Preserve Reasoning In Chat History** separately controls the agent-facing history: turn it on to include that agent's saved reasoning in later model requests, or leave it off to keep the reasoning visible to you without spending later context tokens on it.

An interruption is the one safety override. If you stop an agent while it is reasoning, Batshit gives that unfinished reasoning and plan back to the same agent on its next request even when Display and Preserve are both off. It stays hidden from other agents and disappears after the original agent completes a successful response; failed or interrupted retries do not clear it. Batshit stores and reuses one fixed recovery block, so the interruption and its later expiry each cause only one bounded prompt-cache change. The source run's Execution Viewer reports the pending recovery, and the next run's **Compiled Messages** shows the exact block the agent received. Reasoning tags and their contents do not become part of the normal assistant answer.

For MiMo M2.5 through Vercel Gateway, Batshit normally uses Xiaomi's creator-hosted route because it returns reasoning and final text as separate stream parts. If you explicitly configure a Gateway provider order or restriction, Batshit preserves that choice and still normalizes tagged reasoning when the selected route emits it. Display Reasoning remains a visibility choice; it does not turn the model's thinking mode on or off.

### Thinking mode on Claude models

A Claude preset has a **Thinking mode** (Settings → Models, in the preset's **Reasoning** options). Most Claude models offer **Disabled** and **Enabled**, and a **Thinking budget tokens** box sits beside them. Leave both blank and Batshit sends nothing, so Anthropic's own default applies. Batshit sends the setting on the Anthropic API and on the Vercel AI Gateway; OpenRouter does not carry it.

**Claude Sonnet 5.5 cannot turn thinking off**, and Anthropic refuses the Disabled and Enabled settings for it. Its Thinking mode has one choice, **Between tools (lowest)**: no thinking before the reply, and short progress notes between tool calls. Batshit offers no budget box for this model, because Between tools takes none, and a budget saved earlier is not sent (the preset editor may still list it under Custom Parameters as a row that Batshit does not send).

- A Sonnet 5.5 preset saved with **Disabled** is shown as **Between tools (lowest)** and sent that way. The word stored in the preset may still read Disabled; what you see and what Batshit sends is Between tools.
- A Sonnet 5.5 preset saved with **Enabled** cannot be sent on the Anthropic API or the Vercel AI Gateway. Batshit does not swap it for another setting: the message says so, and a note appears beside the field in Settings → Models. Choose Between tools, or clear the field, and send again.

**Claude Opus 5.5, Claude Fable 5, and Claude Fable 5.1 always think.** A preset saved with **Disabled**, **Enabled**, or a **Thinking budget tokens** value cannot be sent to them on the Anthropic API or the Vercel AI Gateway. Batshit does not change the preset for you: the message says what to clear. Leave both fields blank and Batshit sends nothing, so Anthropic's default applies.

## How presets connect to keys and Local AI

Presets sit in the middle of three things:

- **Provider keys** decide whether a connection is usable. A preset on a connection with no saved key shows as locked for `API` agents until you add the key. Keys live in Settings → API Keys — see [API keys and models](api-keys-and-models.md).
- **The Model Catalog** is where the preset's model comes from. You browse the catalog, apply a selection into the preset form, and save.
- **[Local AI](../local-ai/overview.md) programs** feed the catalog too. Once a program like Ollama or LM Studio is enabled and reachable, its models appear in the catalog and you can save a local preset exactly like a hosted one. Local presets aren't blocked the way cloud presets are when a key is missing, since most local programs don't need one. Where a program reports them, a local catalog entry also carries the model's format tag and the context size it's actually loaded with.
- **Ollama support** comes from the exact model's reported metadata. Opening a preset or refreshing the catalog can show previously unknown Vision and Reasoning support, including the Thinking control, without saving or resetting your preset. Explicit restrictions, parameter values and your tools choice stay in place. Missing or unusable metadata remains unknown. See [local model settings](../local-ai/model-settings.md#thinking-effort-per-program).

So the normal flow is: add a key (or enable a local program) → find the model in the catalog → save a preset → select that preset on an agent.

## Chat presets vs other presets

Agent and chat-bar pickers only show chat-capable presets on purpose. The catalog also carries non-chat models — image, audio, and utility models — and those presets stay available in Settings → Models for Artifacts and advanced workflows, but they won't clutter the list when you're choosing a model for an agent to talk with.

Batshit normally fills the category from the catalog. If a provider's metadata is incomplete or wrong, open the preset in Settings → Models and change **Preset Category** yourself. A manual category choice is saved with that preset and wins over future automatic guesses. Choose **Automatic** to remove your override and return to the catalog's category (or Batshit's best inference for a manual model).

Existing catalog-backed presets are checked again when Batshit loads them. If an older preset was accidentally classified from a capability tag — for example, a chat model with OCR support being placed under Utility — Batshit repairs it from the catalog unless you deliberately chose a manual category.

## How each Primary Agent type uses models

Model Presets are an `API` concept. The other Primary Agent types pick models differently:

- **`API` Primary Agents** select a saved Model Preset directly. This is the path this page is about.
- **n8n Workflow Subagents** use whatever model and provider nodes you configure inside the n8n workflow. Their credentials live in n8n, while the saved Batshit model preset records compatibility and presentation.
- **`CLI` Primary Agents** use their CLI runtime's own model selection (the Codex or Claude Code login), not an `API` Model Preset.

If you connect more than one Primary Agent type, expect models to be configured in more than one place — that's by design, not a bug.

## Troubleshooting

### A preset shows as locked

The connection it uses probably has no saved key, or the key was deleted. Add or fix the key in Settings → API Keys, and confirm the preset's connection shows Ready.

### A custom provider says Not Configured

Its saved key is missing or cannot be read, so its presets appear locked in Models. This can happen after restoring a backup that leaves secrets out. Open **Settings → API Keys → Custom OpenAI-Compatible**, choose **Edit**, enter the key your host asks for, and save. A short non-empty key is accepted. If you leave the key blank and Batshit cannot read the old one, it refuses the save and keeps the saved provider as it was.

### A preset says "Vercel AI Gateway no longer lists this model"

The gateway stopped offering that model. Batshit keeps the preset so you do not lose its settings, but an agent that uses it cannot send: the chat says the gateway no longer lists the model. Pick another model for those agents, then delete the old preset if you no longer need it.

### A preset will not delete

Batshit will not delete a preset that something still uses, because that thing would stop working. The message names each one: an agent's model, a Subagent's model, an agent's Auto Compact or memory summary model, the default Auto Compact model (Settings → Admin), the Memory System's embedding model (Settings → Memory), or an artifact's model. Pick a different model in each of those places, then delete the preset.

### A model isn't in the catalog

Confirm the provider key is saved and the connection is Ready, or that the local program is enabled and reachable. Remember catalog refresh isn't instant, so a brand-new provider model may not have synced yet.

### My agent uses the wrong model

Check which preset the agent has selected, and that the preset pins the connection you intended. The same model on two routes is two different presets.

### A chat model appears under Utility

Open the preset in Settings → Models and check **Preset Category**. **Automatic** uses the current catalog classification; choosing **Chat (Agents)** saves a manual override and makes the preset available to agents and the chat bar. Chat models that merely support OCR should remain Chat — Utility is for dedicated non-chat endpoints such as embeddings or standalone OCR.

### A Claude Sonnet 5.5 message says Thinking mode "enabled" is not available

The preset still holds the Enabled setting, which Claude Sonnet 5.5 refuses. Open the preset in Settings → Models, set **Thinking mode** to **Between tools (lowest)** or clear it, and save.

### A Claude Opus 5.5, Fable 5, or Fable 5.1 message says the model always thinks

The preset holds Thinking mode Disabled or Enabled, or a Thinking budget. Open the preset in Settings → Models, clear **Thinking mode** and **Thinking budget tokens**, and save.

### A manually entered model says “not found”

Manual entries are sent using the Developer ID and Model ID you enter. Copy the exact request identifier from that provider's documentation or model list, including punctuation and capitalization. Catalog-backed presets do this automatically.

## Related docs

- [API keys and models](api-keys-and-models.md)
- [Local AI](../local-ai/overview.md)
