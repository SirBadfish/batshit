# Providers

Providers are how Batshit gets access to AI models — the API keys you save, the Model Presets you build on top of them, the Model Catalog that helps you create those presets, and the CLI providers (Codex and Claude Code) that run as their own managed agents. This page explains how those pieces fit together so the detail pages make sense.

In Batshit, "provider" mostly means a source of model intelligence. Most of the time that's a hosted AI provider you reach with an API key. But CLI tools and Local AI runtimes are also ways to bring models in, and it helps to know where each one lives.

## The pieces

- **API keys** — the secrets that let Batshit talk to a hosted provider like OpenAI, Anthropic, Google, Groq, OpenRouter, or Vercel AI Gateway. Saved in Settings → API Keys and encrypted at rest.
- **Model Presets** — saved, named model configurations (provider connection plus model ID plus options like tools, image transport, reasoning, and pricing). Built in Settings → Models. Agents pick a preset instead of repeating provider settings everywhere.
- **Model Catalog** — a helper that knows about a lot of models across providers and can turn a catalog entry into a saved preset for you, so you don't have to hand-enter every model ID and capability.
- **CLI providers** — Codex CLI and Claude Code CLI. These aren't hosted-key providers; they're command-line agents Batshit installs and manages, then you log into. They power `CLI` Primary Agents.

## How keys and presets work together

A provider key on its own doesn't tell Batshit which model to run or how to run it. A Model Preset does. The normal flow is:

1. Save a provider key in Settings → API Keys.
2. Create a saved Model Preset in Settings → Models that uses that provider connection and a specific model.
3. Point an `API` Primary Agent (or Subagent) at that preset.

The payoff is reuse: set a model up once as a preset, then select it anywhere. Clear preset names help — things like `OpenAI - GPT daily`, `Anthropic - Writing`, or `Groq - Fast`.

For the full walkthrough — adding keys, the provider list, prompt caching behavior, and how Batshit keys differ from n8n credentials and CLI login — see [API keys and models](api-keys-and-models.md).

## Provider keys versus Local AI runtimes

These are two different ways to reach a model, and Batshit keeps them in separate places:

- **Provider keys (API)** are for hosted models you reach over the internet. They live in Settings → API Keys. You're sending requests to someone else's servers, billed by that provider.
- **Local AI runtimes** are models running on your own computer or network — through Ollama, LM Studio, Docker Model Runner, llama.cpp, or vLLM. They live in Settings → Local AI, not API Keys, because they're a URL to a local engine rather than a hosted-provider secret. After connecting one, you still create a Model Preset that uses it.

If you want models that run on your own hardware, start with [Local AI](../local-ai/overview.md). If you want hosted models, start with the API key flow.

## CLI providers (Codex and Claude Code)

`CLI` Primary Agents run a real command-line coding agent — Codex or Claude Code — inside Batshit. Setting one up is a two-part job:

1. **Install the CLI.** The easy path is the one-click managed install in Agent Settings: Batshit downloads an official, checksum-verified copy and manages it. You can also bring your own if you already have `codex` or `claude` installed.
2. **Log in.** Installing isn't authenticating. After install, you run the CLI's login command (Batshit shows the exact one for your setup). Provider API keys saved in Batshit do **not** log the CLI in — they're separate auth paths.

The install cards and login steps are covered in the install guides: [Install Mac app](../installation/install-mac-app.md) and [Install Docker](../installation/install-docker.md).

## In this section

- [API keys and models](api-keys-and-models.md) — add provider keys, build Model Presets, and understand prompt caching and the Batshit-versus-n8n key boundary.
- [Model Catalog](model-catalog.md) — browse known models across providers and create presets from catalog entries.

## Related

- [Local AI](../local-ai/overview.md) — run models on your own machine or network.
- [Primary Agents](../primary-agents/overview.md) — how `API` and `CLI` agents use these providers, and how n8n Workflow Subagents keep their provider setup inside n8n.
- [Connect n8n](../primary-agents/connect-n8n.md) — provider credentials for `n8n` agents live inside n8n, not Batshit's API Keys.
