# Model Catalog and Model Presets

The Model Catalog is Batshit's centralized list of AI models across every provider you can reach, and a Model Preset is a saved, reusable configuration that pins one model plus its settings so your agents don't have to repeat that setup. This page teaches both concepts and how they fit together. For adding the provider keys that unlock those models — and the step-by-step preset form — see [API keys and models](api-keys-and-models.md).

## What the Model Catalog is

Every AI provider has its own model list, its own names, and its own quirks. Without help, you'd be copy-pasting model IDs like `gpt-5.2` or `claude-sonnet-4-5` by hand and hoping you got them right.

The Model Catalog solves that. It's one combined, searchable list that pulls together:

- Hosted gateway models (Vercel AI Gateway, OpenRouter, and the providers they front).
- Direct provider models for providers you've connected — OpenAI, Anthropic, Google, xAI, Mistral, Groq, DeepSeek, and more.
- Your own [Local AI](../local-ai/overview.md) models, once a local runtime is enabled and reachable.

Instead of memorizing model IDs, you browse the catalog, filter to what you want, and let Batshit fill in the exact identifiers. It lives in Settings → Models, with a toggleable catalog viewer for browsing and searching the full normalized list.

When catalog data includes a trustworthy max output token limit, Batshit fills it into the preset. If the catalog does not provide that limit, or reports a value that would reserve nearly the whole context window for output, Batshit fills a conservative safe default instead. In that case the Max Output Tokens row shows an **Estimated** badge so you know the value is a Batshit default, not confirmed provider metadata.

## How a model gets named

Batshit describes every model with three parts, because "the OpenAI model on OpenRouter" and "the OpenAI model called directly" are not the same route even when it's the same model:

| Part | What it means | Example |
| --- | --- | --- |
| Provider / connection | The route and key Batshit uses to reach the model | `direct:anthropic`, `openrouter`, `vercel-gateway` |
| Developer | The company that made the model | `openai`, `anthropic`, `google` |
| Model ID | The developer's specific model | `gpt-5.2`, `claude-sonnet-4-5` |

The same model can show up on more than one route. A single catalog entry can advertise every transport it works with, so you pick the model first, then choose which connection carries it.

This matters because the provider/connection is what decides which saved key gets used. A Google-made model reached through a gateway uses that gateway's key, not your direct Google key.

## How catalog content stays current

The catalog isn't a hardcoded list baked into the app. Batshit refreshes a shared model snapshot from a hosted registry and from live provider model lists, then merges in your local runtime models on the fly.

A few honest notes:

- New models show up and retired ones drop off as providers change their lists.
- If a provider's list is briefly unreachable, Batshit keeps the last known set for that provider rather than wiping it, so a provider hiccup doesn't make your models vanish.
- Catalog freshness isn't instant. A model a provider added minutes ago may not appear until the next refresh.

If a model you expect is missing, confirm the relevant provider key is saved and the connection shows Ready before assuming the catalog is broken.

## What a Model Preset is

A Model Preset is a saved bundle: one model, on one connection, with its settings locked in and given a clear name. Once saved, any `API` agent can select that preset instead of re-choosing a provider, model, and a pile of options every time.

A preset captures things like:

- The provider connection and the exact model ID.
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

### Reasoning from OpenAI-compatible models

Reasoning-capable models do not all send their thinking the same way. Some providers return a dedicated reasoning field, while models such as MiMo or some DeepSeek/open-model routes may place it inside `<think>...</think>` tags in the ordinary text stream.

For `API` agents, Batshit normalizes both formats into the same reasoning panel when the preset is marked reasoning-capable or the model/provider is a known MiMo or DeepSeek path. **Display Reasoning** controls whether that panel is shown, and **Preserve Reasoning** controls whether it remains after the live response. The tags and their contents do not become part of the normal assistant answer.

For MiMo M2.5 through Vercel Gateway, Batshit normally uses Xiaomi's creator-hosted route because it returns reasoning and final text as separate stream parts. If you explicitly configure a Gateway provider order or restriction, Batshit preserves that choice and still normalizes tagged reasoning when the selected route emits it. Display Reasoning remains a visibility choice; it does not turn the model's thinking mode on or off.

## How presets connect to keys and Local AI

Presets sit in the middle of three things:

- **Provider keys** decide whether a connection is usable. A preset on a connection with no saved key shows as locked for `API` agents until you add the key. Keys live in Settings → API Keys — see [API keys and models](api-keys-and-models.md).
- **The Model Catalog** is where the preset's model comes from. You browse the catalog, apply a selection into the preset form, and save.
- **[Local AI](../local-ai/overview.md) runtimes** feed the catalog too. Once a local runtime like Ollama or LM Studio is enabled and reachable, its models appear in the catalog and you can save a local preset exactly like a hosted one. Local presets aren't blocked the way cloud presets are when a key is missing, since local runtimes don't use hosted-provider keys.

So the normal flow is: add a key (or enable a local runtime) → find the model in the catalog → save a preset → select that preset on an agent.

## Chat presets vs other presets

Agent and chat-bar pickers only show chat-capable presets on purpose. The catalog also carries non-chat models — image, audio, and utility models — and those presets stay available in Settings → Models for Artifacts and advanced workflows, but they won't clutter the list when you're choosing a model for an agent to talk with.

## How each Primary Agent type uses models

Model Presets are an `API` concept. The other Primary Agent types pick models differently:

- **`API` Primary Agents** select a saved Model Preset directly. This is the path this page is about.
- **`n8n` Primary Agents** use whatever model and provider nodes you configure inside the n8n workflow. Their credentials live in n8n, so Batshit doesn't gate them on Batshit-side keys.
- **`CLI` Primary Agents** use their CLI runtime's own model selection (the Codex or Claude Code login), not an `API` Model Preset.

If you connect more than one Primary Agent type, expect models to be configured in more than one place — that's by design, not a bug.

## Troubleshooting

### A preset shows as locked

The connection it uses probably has no saved key, or the key was deleted. Add or fix the key in Settings → API Keys, and confirm the preset's connection shows Ready.

### A model isn't in the catalog

Confirm the provider key is saved and the connection is Ready, or that the local runtime is enabled and reachable. Remember catalog refresh isn't instant, so a brand-new provider model may not have synced yet.

### My agent uses the wrong model

Check which preset the agent has selected, and that the preset pins the connection you intended. The same model on two routes is two different presets.

## Related docs

- [API keys and models](api-keys-and-models.md)
- [Local AI](../local-ai/overview.md)
