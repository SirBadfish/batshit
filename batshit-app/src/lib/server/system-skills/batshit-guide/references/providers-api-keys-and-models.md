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

## Connect a ChatGPT plan in the Mac app

You can use your ChatGPT plan with an ordinary **API** agent in the local Batshit Mac app. OpenAI decides which models and limits your account can use. This connection currently requires the Mac app; Docker support is not available yet.

1. Open **Settings → API Keys → ChatGPT Plan**.
2. Choose **Continue with ChatGPT** and finish sign-in and consent in your browser. If no browser opens, use **Open ChatGPT Sign-In**.
3. Wait for your account to say **Connected**. Signing in without granting plan use cannot run models.
4. Open **Settings → Models**, select **ChatGPT Plan** for that account and choose a model from its list. Save the preset.
5. Choose that preset for an **API** agent and chat normally.

Normal conversation history, memory context and Batshit's permitted tools follow the same API-agent path. API Subagents and Workers can use a plan preset within their own permissions. Plain Compact can use it too. Memory's background summary features, artifacts, embeddings, voice/media and n8n need a separate supported connection.

Image-capable models can inspect image Clips. In Models, **View Details** separates verified published model properties from your account's unknown effective limits; it includes the official source and verification date. **Refresh** fetches the account's current choices, while published metadata is audited through Batshit's daily catalog maintenance. See [ChatGPT plan catalog details](model-catalog.md#chatgpt-plan-models) for context and capability guidance.

**Total Cost** becomes **ChatGPT Plan** with [Manage ChatGPT Usage](https://chatgpt.com/settings/usage). Context token counts, context-window percentage, cache/speed displays, Trim and Compact remain. Batshit has no supported subscription percentage or reset-time feed; check ChatGPT's usage page. If a request reaches a plan limit, Batshit shows the failure and usage link. It never switches to a paid API key automatically.

Use **Disconnect** here to remove local access. If OpenAI revocation cannot be confirmed, Batshit says so; manage its connection in ChatGPT settings. A restored model preset does not carry the login, even in a With Secrets backup. Sign in and select the new account connection on the target Mac. OpenAI API keys and Codex CLI login remain separate connections.

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
- Kimi Code Membership
- MiniMax
- MiniMax Token Plan
- MiMo
- MiMo Token Plan
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

Regular Z.ai and Z.ai Coding Plan use separate keys and endpoints. Saving `ZAI_API_KEY` enables the regular pay-as-you-go connection only; it does not silently route requests through the Coding Plan endpoint. The Coding Plan connection uses Z.ai's OpenAI-compatible coding endpoint and currently offers **GLM-5.3** and **GLM-5.3-Flash** in Batshit. Older compatibility aliases are hidden so a preset names the model that will actually run; newly advertised future models can still enter the live catalog.

Qwen Cloud and Qwen Token Plan also use separate keys and endpoints. Keep your normal pay-as-you-go key in **Qwen Cloud**, and save the subscription key that starts with `sk-sp-` in **Qwen Token Plan**. Batshit uses Alibaba's OpenAI-compatible Token Plan endpoint automatically; the `ap-southeast-1` hostname is fixed because Token Plan is currently available only in Singapore, not because Batshit guessed your physical location.

Batshit's Token Plan fallback list follows Alibaba's published Personal Edition text-model list and is merged with live `/models` discovery when an environment key is available. It includes the September 2026 additions **DeepSeek V4.1 Flash** and **GLM-5.3** even when the hosted registry cannot make a keyed discovery call.

Alibaba limits Token Plan to interactive coding and agent tools. Use the Batshit connection for interactive chats and agents only. Do not use that plan key for n8n workflows, automation, batch calls, automated scripts, or generic application-backend work; Alibaba says out-of-scope use can suspend the subscription or key. The pay-as-you-go Qwen Cloud connection remains the unrestricted Batshit route for those other uses.

Token Plan Personal is also licensed for one device at a time. Do not run the same subscription key simultaneously from Batshit on multiple computers; keep the pay-as-you-go Qwen Cloud key available on the other machine instead.

Kimi, MiniMax, and MiMo also have separate subscription connections:

- **Kimi Code Membership** uses the membership key from Kimi Code Console and the overseas coding endpoint. It exposes `k3`, `k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed`; availability still depends on your Kimi membership tier. Keep ordinary Moonshot pay-as-you-go keys in **Moonshot AI**.
- **MiniMax Token Plan** uses the separate `sk-cp` subscription key. Batshit exposes the current M3/M2.7 text set and can use the same plan key for eligible MiniMax speech. MiniMax describes this plan as interactive individual/developer use and recommends pay-as-you-go for production workloads.
- **MiMo Token Plan** uses the separate `tp-` subscription key. Batshit defaults to Xiaomi's Singapore OpenAI-compatible endpoint and exposes MiMo V2.5 Pro/V2.5 plus the plan's ASR/TTS audio models. Advanced self-hosters can override the endpoint with the exact China or Europe URL shown in their MiMo console.

These rows do not replace or overwrite **Moonshot AI**, **MiniMax**, or **MiMo** pay-as-you-go keys. When both a pay-as-you-go and subscription speech key are saved for MiniMax or MiMo, Batshit prefers the subscription quota for eligible speech.

### Paused plans

Some sellers allow their flat-fee plans only inside tools they list, and they do not list Batshit yet. Batshit has paused these plans:

- **Z.ai Coding Plan** (use **Z.ai** pay-as-you-go instead)
- **Qwen Token Plan** from Alibaba Cloud (use **Qwen Cloud** pay-as-you-go instead)
- **MiMo Token Plan** from Xiaomi (use **MiMo** pay-as-you-go instead)

A paused plan is switched off, not deleted. You cannot add its key or a new model for it, and a saved model of that plan does not run: the chat or the MiMo voice shows why and does not move to another connection on its own. Your saved key stays where it was, and the plan's row in **Settings -> API Keys** says it is paused. Once Batshit has asked a seller for approval, the row shows the date. A plan comes back when its seller says yes. Kimi Code and the MiniMax Token Plan are not paused.

Every call Batshit makes to a model seller names Batshit in its `User-Agent` header, for example `Batshit/0.1.0-alpha.2 (+https://batshit.ai)`, so a seller can see which calls come from Batshit.

## Create a saved model preset

1. Open Settings → Models.
2. In **Browse Model Catalog**, pick the **Provider**: the key you added shows as `<Name> (Direct)`, for example `Anthropic (Direct)`; Vercel AI Gateway, OpenRouter, and Local AI programs have their own entries.
3. Pick the **Developer** (the company that made the model), then pick a **Model**. Batshit never picks the model for you: the list holds every model that provider serves, older ones included, so choose a current one on purpose (for example Claude Sonnet 5, or a current GPT chat model).
4. Choose **Use to Create New Preset**. You should see **Model preset created**, and the preset appears under **Saved Models**. If you already made a preset from that model with the same name, Batshit says a preset with that name already exists and saves nothing; change the display name to keep both.
5. Check the details it filled in: tools, image support, reasoning, context window, and pricing. Change anything provider-specific there; it saves by itself.
   If the catalog does not list a price or a context window for that API model, the field stays blank. The chat then shows its running cost or context use as **Unknown** instead of guessing; type the price or window in to get a real number. A price of `0` is kept as free. Codex and Claude Code CLI agents use their selected CLI model's known window or a matching CLI-reported window instead of the generic CLI preset's blank value. An unknown CLI limit leaves the percentage blank while retaining the used-token count. Local AI programs, Codex CLI, and Claude Code CLI are always priced at `0` per token, because they run on your own computer or on a plan you already pay for.

The model list only shows models that run on the provider you picked. A model that only Vercel AI Gateway or OpenRouter serves appears under those providers, not under the direct one. For a model the catalog doesn't cover, providers like Alibaba Cloud, StepFun, and your custom OpenAI-compatible providers use manual entry instead.

Use clear names, like:

- `OpenAI - GPT daily`
- `Anthropic - Writing`
- `Groq - Fast`
- `Ollama - Local`
- `OpenRouter - Long context`

Saved presets make agent setup easier: agents pick a preset instead of repeating provider/model settings everywhere.

## Prompt caching on API agents

For `API` Primary Agents, Batshit automatically uses provider-side prompt/input caching options where they are supported. OpenAI gets a Batshit-generated cache key, Anthropic gets cache control, OpenRouter gets sticky session routing plus usage reporting, Vercel AI Gateway gets automatic caching, direct Gemini relies on Google's implicit prompt caching, and both Qwen Cloud connections use the official Alibaba provider's cache support. Advanced provider settings can still override supported provider options, but normal users should not need to configure prompt caching by hand.

ChatGPT Plan uses only the plan's supported inference options; Batshit does not apply paid OpenAI cache options to that connection.

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

Local AI programs — Ollama, LM Studio, Docker Model Runner, llama.cpp, vLLM, SGLang, oMLX — aren't normal hosted-provider API keys. Configure them in Settings → Local AI, then create model presets that use those connections.

They **can** carry a key, though, if the program asks for one — oMLX with its key check on, LM Studio 0.4 with tokens, or vLLM or SGLang started with `--api-key`. All seven are listed here under **Local AI**, alongside your cloud keys, and that is the only place they live. Leave it blank if your program doesn't ask; most local setups need no key at all.

Mac app or host program:

- A local program URL often looks like `http://localhost:11434`.

Docker:

- A host program usually needs `http://host.docker.internal:11434` from the app container.
- A same-Compose sidecar uses its service name.

If a Local AI URL works in your browser but fails from Docker Batshit, check the caller URL.

## Voice keys

Cloud voice providers also use Settings → API Keys.

The saved Google key powers both Gemini TTS and recorded Gemini 3.5 Transcribe. The saved Deepgram key powers recorded/realtime STT plus Aura and Flux batch TTS; realtime Deepgram Flux TTS is a separate future WebSocket lane. MiMo V2.5 ASR is also available for recorded/uploaded WAV or MP3 audio with either the pay-as-you-go key or the separate MiMo Token Plan key.

Fish Audio and Inworld are Batshit's direct realtime TTS providers. Fish needs both:

- a Fish API key
- a Fish voice selected in Voice Settings or supplied by the request as `voiceId`

Inworld needs an Inworld API key and a selected Inworld voice in Voice Settings. When 3D Goon Lip Sync is set to Rhubarb WASM / the Premium viseme lane, Inworld realtime TTS can also use Inworld's provider phoneme/viseme timing for live Goon mouth shapes without waiting for Rhubarb WASM analysis.

MiniMax, MiMo, Alibaba Cloud, and StepFun share their pay-as-you-go saved key between direct model-provider and built-in speech lanes. MiniMax Token Plan and MiMo Token Plan remain separate saved-key rows; eligible speech prefers the subscription key when present. Inworld, Cartesia, Async, and Azure Speech are TTS-only provider rows; Inworld supports Batshit-owned direct realtime TTS, while Cartesia, Async, and Azure Speech remain batch TTS lanes in Batshit until direct streaming adapters land.

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
