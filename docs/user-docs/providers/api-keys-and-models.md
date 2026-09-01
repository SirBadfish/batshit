# API keys and models

Batshit can talk to AI providers directly, route through gateway-style providers, connect to Local AI runtimes, and hand work to n8n or CLI agents. This page covers the first two setup surfaces most users need: API keys and model presets.

## The short version

To use an `API` Primary Agent:

1. Add a provider key in Settings → API Keys.
2. Create a saved model preset in Settings → Models.
3. Select that preset on an `API` Primary Agent.

To use an n8n Workflow Subagent:

1. Add provider credentials inside n8n.
2. Configure the workflow's model/provider nodes.
3. Paste the workflow webhook URL into an `n8n Workflow Subagent` in Batshit.
4. Assign it to an `API` or `CLI` Primary Agent.

To use a `CLI` Primary Agent:

1. Install and log in to the CLI.
2. Configure a `CLI` agent in Batshit.
3. Add provider keys only when that CLI path or other Batshit features need them.

## Before saving keys

Batshit encrypts saved API keys and custom provider secrets with `ENCRYPTION_KEY`. Make sure it's set and stable:

- Mac app: Runtime Doctor generated config
- Advanced source checkout: `batshit-app/.env`
- Docker: `.env.docker`

Don't rotate `ENCRYPTION_KEY` casually. If it changes, saved encrypted keys may need to be re-entered.

## Add a provider key

1. Open Settings → API Keys.
2. Open Providers.
3. Use `+ Add New API Key`.
4. Pick the provider.
5. Paste the key.
6. Save.
7. Use Test when the row offers it. For many providers, Test checks the key format only; Batshit tells you when a key wasn't verified with a live provider call.

Saved provider rows show masked values. Batshit never shows the full plaintext key back to you after saving.

Common provider and connection types include:

- OpenAI
- Anthropic
- Google
- xAI (Grok)
- Groq
- Mistral
- Moonshot AI
- MiniMax
- MiMo
- Qwen Cloud
- Qwen Token Plan
- Together.ai
- Fireworks AI
- Baseten
- Cerebras
- Cohere
- Alibaba Cloud Model Studio
- StepFun
- OpenRouter
- Vercel AI Gateway
- DeepSeek
- DeepInfra
- Z.ai, including a separate Z.ai Coding Plan connection for accounts that have that plan
- media, web-search, voice, and Agent Browser cloud providers where supported, including Fish Audio, Inworld, Cartesia, Async, and Microsoft Azure Speech

The exact provider list can change as the model catalog evolves.

Regular Z.ai and Z.ai Coding Plan use separate keys and endpoints. Saving `ZAI_API_KEY` enables the regular pay-as-you-go connection only; it does not silently route requests through the Coding Plan endpoint.

Qwen Cloud and Qwen Token Plan also use separate keys and endpoints. Keep your normal pay-as-you-go key in **Qwen Cloud**, and save the subscription key that starts with `sk-sp-` in **Qwen Token Plan**. Batshit uses Alibaba's OpenAI-compatible Token Plan endpoint automatically; the `ap-southeast-1` hostname is fixed because Token Plan is currently available only in Singapore, not because Batshit guessed your physical location.

Alibaba limits Token Plan to interactive coding and agent tools. Use the Batshit connection for interactive chats and agents only. Do not use that plan key for n8n workflows, automation, batch calls, automated scripts, or generic application-backend work; Alibaba says out-of-scope use can suspend the subscription or key. The pay-as-you-go Qwen Cloud connection remains the unrestricted Batshit route for those other uses.

Token Plan Personal is also licensed for one device at a time. Do not run the same subscription key simultaneously from Batshit on multiple computers; keep the pay-as-you-go Qwen Cloud key available on the other machine instead.

## Create a saved model preset

1. Open Settings → Models.
2. Use the catalog helper or manual preset creation.
3. Choose the provider connection.
4. Choose the developer/model ID.
5. Confirm tools, image transport, reasoning, context, pricing, or other provider-specific settings.
6. Save the preset.

Use clear names, like:

- `OpenAI - GPT daily`
- `Anthropic - Writing`
- `Groq - Fast`
- `Ollama - Local`
- `OpenRouter - Long context`

Saved presets make agent setup easier: agents pick a preset instead of repeating provider/model settings everywhere.

## Prompt caching on API agents

For `API` Primary Agents, Batshit automatically uses provider-side prompt/input caching options where they are supported. OpenAI gets a Batshit-generated cache key, Anthropic gets cache control, OpenRouter gets sticky session routing plus usage reporting, Vercel AI Gateway gets automatic caching, direct Gemini relies on Google's implicit prompt caching, and both Qwen Cloud connections use the official Alibaba provider's cache support. Advanced provider settings can still override supported provider options, but normal users should not need to configure prompt caching by hand.

Cache hits depend on provider rules. Very short prompts may not be eligible, cache entries can expire, and some providers only report cache evidence after a repeated eligible request. Batshit does not use Google's explicit cached-content resources for normal direct Gemini API-agent sends because Google does not allow that cache option to be combined with the live system/tool fields Batshit agents normally use. Image Clips are sent as structured image inputs rather than prompt text, but multimodal turns can still change how a provider applies prompt caching. Some implicit-cache providers may miss, restart, or report smaller cache reads after image turns even when Batshit reuses the same Clip URL or provider file URI. Check the Execution Viewer if you want to see whether a run reported cached input or cache-write tokens.

## Provider keys vs n8n credentials

Batshit Settings → API Keys and n8n credentials are separate.

| Where the key lives | Used by |
| --- | --- |
| Batshit Settings → API Keys | `API` agents, Batshit features, voice providers, Local AI integrations, some CLI-adjacent setup checks |
| n8n Credentials | n8n workflow tools and n8n Workflow Subagents |
| CLI login | `CLI` Primary Agents and CLI Subagents |

Batshit does not copy provider API keys into n8n. If an n8n workflow uses OpenAI, Anthropic, OpenRouter, Vercel AI Gateway, or another provider, create that credential in n8n.

## Runtime-managed infrastructure rows

Some API Keys rows are runtime-managed. They may be copyable, but not editable from the UI.

| Row | What it means |
| --- | --- |
| Batshit Internal Token | Source installs: from root `.env` as `BATSHIT_TOKEN`, shown as **Managed by Source Runtime**. Mac app: generated by Runtime Doctor, shown as **Managed by Mac Runtime**. Docker: from `.env.docker` as `BATSHIT_TOKEN`. Current official n8n templates use scoped per-message native-tool tokens instead, so most users do not need to copy this value. Rotate only deliberately. |
| Artifact Complete URL | Usually uses the Docker default, often `http://app:3000/api/artifacts/complete` internally. A blank saved value isn't automatically broken. |
| Docker MCP Gateway Token | Optional unless you configure Docker MCP Gateway. It can appear from runtime env when configured. |
| n8n URL | The effective runtime URL, such as `http://n8n:5678` for the optional Docker n8n profile or `http://host.docker.internal:5678` for host n8n. |
| n8n API Key | Optional. Needed only for Batshit-side n8n API integrations such as workflow discovery or parameter sync. |
| n8n Instance MCP Token | Optional. Needed only if you use n8n Instance MCP with auth. |

Provider keys are still normal user-entered keys in all installs.

## Local AI

Local AI runtimes — Ollama, LM Studio, Docker Model Runner, llama.cpp, vLLM — aren't normal hosted-provider API keys. Configure them in Settings → Local AI, then create model presets that use those connections.

Mac app or host runtime:

- A local runtime URL often looks like `http://localhost:11434`.

Docker:

- A host runtime usually needs `http://host.docker.internal:11434` from the app container.
- A same-Compose sidecar uses its service name.

If a Local AI URL works in your browser but fails from Docker Batshit, check the caller URL.

## Voice keys

Cloud voice providers also use Settings → API Keys.

Fish Audio and Inworld are Batshit's direct realtime TTS providers. Fish needs both:

- a Fish API key
- a Fish voice selected in Voice Settings or supplied by the request as `voiceId`

Inworld needs an Inworld API key and a selected Inworld voice in Voice Settings. When 3D Goon Lip Sync is set to Rhubarb WASM / the Premium viseme lane, Inworld realtime TTS can also use Inworld's provider phoneme/viseme timing for live Goon mouth shapes without waiting for Rhubarb WASM analysis.

MiniMax, MiMo, Alibaba Cloud, and StepFun share the same saved key between their direct model-provider connection and their built-in TTS lane. Inworld, Cartesia, Async, and Azure Speech are TTS-only provider rows; Inworld supports Batshit-owned direct realtime TTS, while Cartesia, Async, and Azure Speech remain batch TTS lanes in Batshit until direct streaming adapters land.

LiveKit is different — it's a voice runtime, not a TTS/STT engine. LiveKit URL/API key/API secret live under the voice runtime credentials area and may point to the native managed local runtime, Docker's optional `livekit` profile, or an external LiveKit service.

## With-Secrets backups

Normal Batshit backups exclude saved provider keys and tokens.

If you export a backup With Secrets:

- Store it somewhere private.
- Remember it depends on the target instance using the same `ENCRYPTION_KEY`.
- Don't share it in bug reports, Discord, GitHub issues, or public logs.

For normal moves, it's often safer to export without secrets and re-enter provider keys on the new instance.

## Troubleshooting

### Provider says missing API key

Check that the key is saved in Settings → API Keys, the model preset uses the same provider connection, the agent is using that preset, and (for Docker) you didn't accidentally put the key only in n8n.

### n8n workflow can't use a provider

Add or fix the credential in n8n. Batshit provider keys don't automatically appear inside n8n workflows.

### CLI agent can't run

Run the CLI login command. API keys in Batshit don't authenticate the Codex or Claude Code CLI.

If Claude Code on Windows shows `Paste code here if prompted >` after the browser login, paste the browser auth code and press Enter. The pasted code may not appear in the terminal.

### Key worked yesterday but not today

Check whether `ENCRYPTION_KEY` changed, whether the provider revoked the key, or whether the provider changed account limits.

Next: [Connect n8n](../primary-agents/connect-n8n.md)
