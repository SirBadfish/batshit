import type { ProviderAccessResolution, KnownProviderId } from '$lib/server/services/providers'
import type { CatalogConnectionOption } from '$lib/types/modelCatalog'
import type { CustomProviderSummary } from '$lib/types/customProviders'
import { CUSTOM_PROVIDER_KEY_NOT_USABLE } from '$lib/types/customProviders'
import type { LocalAiServerSummary } from '$lib/types/localAi'
import type { PausedPlanStatus } from './pausedPlans'
import { CONNECTION_CREDENTIAL_MAP } from '$lib/server/constants/modelConnections'
import { isManualEntryDirectProvider } from '$lib/utils/modelCatalogConnectionMode'

/** Pure projection. Callers supply admitted stored availability; no probes, reads or secrets. */
export function buildConnectionOptions(
  access: ProviderAccessResolution,
  extras?: {
    customProviders?: CustomProviderSummary[]
    localServers?: LocalAiServerSummary[]
    /** Plan pause: the server's words for each paused plan on this copy. */
    pausedPlans?: Record<string, PausedPlanStatus>
  }
): CatalogConnectionOption[] {
  const options: CatalogConnectionOption[] = []
  const n8nHint = 'Manage credentials in n8n for Modes 1 & 2 plus subagents.'

  const addOption = (option: CatalogConnectionOption) => {
    options.push(option)
  }

  const gatewayStatus = access.gateway.availability
  addOption({
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    transport: 'vercel-gateway',
    service: 'vercel',
    providers: null,
    description: 'Use the hosted Vercel catalog with routing and caching.',
    status: gatewayStatus.hasKey ? 'ready' : 'locked',
    lockedReason: gatewayStatus.hasKey ? undefined : 'Add an AI Gateway key under Settings → API Keys.',
    n8nStatus: 'unknown',
    n8nDescription: n8nHint,
    requiredN8NCredentials: CONNECTION_CREDENTIAL_MAP['vercel-gateway']
  })

  const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
  const directProviders: KnownProviderId[] = [
    'anthropic',
    'openai',
    'google',
    'mistral',
    'groq',
    'xai',
    'deepseek',
    'moonshot',
    'kimi_code',
    'minimax',
    'minimax_token_plan',
    'mimo',
    'mimo_token_plan',
    'qwencloud',
    'qwen_token_plan',
    'alibaba',
    'stepfun',
    'zai',
    'zai_coding',
    'fal',
    'luma',
    'replicate',
    'elevenlabs',
    'deepgram',
    'assemblyai',
    'cohere',
    'deepinfra',
    'togetherai',
    'fireworks',
    'baseten',
    'cerebras'
  ]
  const DIRECT_PROVIDER_LABELS: Partial<Record<KnownProviderId, string>> = {
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    zai: 'Z.ai General',
    zai_coding: 'Z.ai Coding Plan',
    xai: 'xAI',
    moonshot: 'Moonshot AI',
    kimi_code: 'Kimi Code Membership',
    minimax: 'MiniMax',
    minimax_token_plan: 'MiniMax Token Plan',
    mimo: 'MiMo',
    mimo_token_plan: 'MiMo Token Plan',
    qwencloud: 'Qwen Cloud',
    qwen_token_plan: 'Qwen Token Plan',
    alibaba: 'Alibaba Cloud',
    stepfun: 'StepFun',
    fal: 'fal.ai',
    luma: 'Luma',
    replicate: 'Replicate',
    elevenlabs: 'ElevenLabs',
    deepgram: 'Deepgram',
    assemblyai: 'AssemblyAI',
    cohere: 'Cohere',
    deepinfra: 'DeepInfra',
    togetherai: 'Together.ai',
    fireworks: 'Fireworks AI',
    baseten: 'Baseten',
    cerebras: 'Cerebras'
  }
  const DIRECT_PROVIDER_DESCRIPTIONS: Partial<Record<KnownProviderId, string>> = {
    zai_coding: 'Use current Z.ai Coding Plan models, including GLM-5.3 and GLM-5.3-Flash, through the OpenAI-compatible coding endpoint.',
    xai: 'Use xAI Grok models through the OpenAI-compatible xAI API.',
    moonshot: 'Use Moonshot AI Kimi models through the OpenAI-compatible Kimi API.',
    kimi_code:
      'Use Kimi Code membership quota and its separate coding endpoint. This connection does not spend Moonshot pay-as-you-go balance.',
    minimax: 'Use MiniMax M-series models through the OpenAI-compatible MiniMax API.',
    minimax_token_plan:
      'Use the separate MiniMax sk-cp subscription key for interactive M3 and M2.7 work. MiniMax recommends pay-as-you-go for production use.',
    mimo: 'Use Xiaomi MiMo V2.5 models through the OpenAI-compatible MiMo API.',
    mimo_token_plan:
      'Use the separate Xiaomi MiMo tp- subscription key for the V2.5 chat and speech model family.',
    qwencloud: 'Use Qwen and other DashScope-hosted models through Qwen Cloud.',
    qwen_token_plan:
      'Use the Alibaba Token Plan subscription route for interactive Batshit chats and agents. Alibaba excludes workflow, batch, and generic backend use.',
    alibaba: 'Use Alibaba Cloud Model Studio Qwen models through DashScope OpenAI-compatible mode.',
    stepfun: 'Use StepFun chat models through the OpenAI-compatible StepFun API.',
    zai: 'Use Z.ai GLM models via the OpenAI-compatible general endpoint.',
    fal: 'Use fal.ai image + audio models (Flux, Minimax TTS) with your API key.',
    luma: 'Use Luma Photon image/video models with your API key.',
    replicate: 'Use Replicate hosted models (Flux, etc.) with your API key.',
    elevenlabs: 'Use ElevenLabs speech + transcription models with your API key.',
    deepgram: 'Use Deepgram transcription models with your API key.',
    assemblyai: 'Use AssemblyAI transcription models with your API key.',
    cohere: 'Use Cohere chat, embeddings, rerank, and transcription models with your API key.',
    deepinfra: 'Use DeepInfra hosted chat models through the built-in live model catalog.'
  }
  for (const provider of directProviders) {
    const status = access.availability[provider]
    const manualEntry = isManualEntryDirectProvider(provider)
    const providerLabel = DIRECT_PROVIDER_LABELS[provider] ?? titleCase(provider)
    const providerDescription =
      DIRECT_PROVIDER_DESCRIPTIONS[provider] ??
      (manualEntry
        ? `${providerLabel} requires manual model entry (catalog sync coming later).`
        : `Call ${providerLabel} with your own API key for lowest latency.`)
    const lockedReason = `Add a ${providerLabel} API key under Settings → API Keys.`
    // Plan pause: a paused plan is locked with its plain words; on a Dev copy
    // that allows paused plans its description says so.
    const pausedPlan = extras?.pausedPlans?.[provider]
    const planLocked = pausedPlan?.paused === true
    addOption({
      id: `direct:${provider}`,
      label: `${providerLabel} (Direct)`,
      transport: 'direct',
      service: provider,
      providers: [provider],
      description: pausedPlan ? `${pausedPlan.message} ${providerDescription}` : providerDescription,
      status: status?.hasKey && !planLocked ? 'ready' : 'locked',
      lockedReason: planLocked ? pausedPlan.message : status?.hasKey ? undefined : lockedReason,
      n8nStatus: 'unknown',
      n8nDescription: n8nHint,
      requiredN8NCredentials: CONNECTION_CREDENTIAL_MAP[`direct:${provider}`]
    })
  }

  const openrouterStatus = access.availability.openrouter
  addOption({
    id: 'openrouter',
    label: 'OpenRouter',
    transport: 'openrouter',
    service: 'openrouter',
    providers: ['anthropic', 'openai', 'google', 'mistral', 'meta', 'meta-llama', 'groq', 'xai', 'qwen', 'deepseek', 'cohere', 'ai21'],
    description: 'Route through OpenRouter to access hundreds of hosted models.',
    status: openrouterStatus?.hasKey ? 'ready' : 'locked',
    lockedReason: openrouterStatus?.hasKey
      ? undefined
      : 'Add an OpenRouter API key under Settings → API Keys.',
    n8nStatus: 'unknown',
    n8nDescription: n8nHint,
    requiredN8NCredentials: CONNECTION_CREDENTIAL_MAP['openrouter']
  })

  if (extras?.customProviders?.length) {
    for (const provider of extras.customProviders) {
      addOption({
        id: `direct:${provider.id}`,
        label: `${provider.label} (Custom)`,
        transport: 'direct',
        service: provider.id,
        providers: [provider.id],
        description: 'Custom OpenAI-compatible provider (manual model entry required).',
        // Packet 5 finding 1: a provider whose saved key is missing (restored
        // without secrets) or cannot be read is never registered at run time.
        status: provider.apiKeyUsable ? 'ready' : 'locked',
        lockedReason: provider.apiKeyUsable ? undefined : CUSTOM_PROVIDER_KEY_NOT_USABLE,
        n8nStatus: 'locked',
        n8nDescription: 'Custom providers are only available in Batshit direct mode.',
        requiredN8NCredentials: []
      })
    }
  }

  if (extras?.localServers?.length) {
    for (const server of extras.localServers) {
      const enabled = server.enabled !== false
      addOption({
        id: `direct:${server.id}`,
        label: `${server.label} (Local)`,
        transport: 'direct',
        service: server.id,
        providers: [server.id],
        description: `OpenAI-compatible local endpoint at ${server.baseUrl}${server.openaiPath}.`,
        status: enabled ? 'ready' : 'locked',
        lockedReason: enabled ? undefined : 'Enable this runtime in Settings → Local AI.',
        n8nStatus: 'unknown',
        n8nDescription: enabled ? n8nHint : 'Enable this runtime in Settings → Local AI.',
        requiredN8NCredentials: CONNECTION_CREDENTIAL_MAP[`direct:${server.id}`] ?? []
      })
    }
  }

  return options
}
