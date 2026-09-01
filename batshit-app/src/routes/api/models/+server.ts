/**
 * Model Listing API Endpoint
 * Story 5.3: Provider Management System
 *
 * Returns available AI models with metadata for UI population
 * SECURITY: Never expose API keys in responses
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { env } from '$env/dynamic/private'
import { logger } from '$lib/utils/logger'
import {
  ProviderManager,
  resolveProviderAccess,
  type ProviderAccessResolution,
  type KnownProviderId
} from '$lib/server/services/providers'
import { fetchVercelModelCatalog } from '$lib/server/services/vercelModelCatalog'
import type { CatalogModel, CatalogConnectionOption } from '$lib/types/modelCatalog'
import { CONNECTION_CREDENTIAL_MAP, gatherCredentialTypes } from '$lib/server/constants/modelConnections'
import { getN8NCredentialStatuses, type N8NCredentialStatusResult } from '$lib/server/services/n8nCredentials'
import { detectCodexCliStatus, type CodexCliStatus } from '$lib/server/services/codexCliStatus'
import { detectClaudeCliStatus, type ClaudeCliStatus } from '$lib/server/services/claudeCliStatus'
import { listCustomProviders } from '$lib/server/services/customProviders'
import type { CustomProviderSummary } from '$lib/types/customProviders'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl } from '$lib/server/services/localAiServers'
import type { LocalAiServerSummary } from '$lib/types/localAi'
import { isManualEntryDirectProvider } from '$lib/utils/modelCatalogConnectionMode'

const CODEX_PROVIDER_ENABLED = env.BATSHIT_CODEX_PROVIDER_ENABLED !== 'false'
const CODEX_PROVIDER_ID = 'openai-codex'
const CODEX_CONNECTION_ID = 'codex-cli'
const CODEX_DISPLAY_NAME = 'Codex CLI (GPT Plus/Pro)'
const CLAUDE_PROVIDER_ENABLED = env.BATSHIT_CLAUDE_PROVIDER_ENABLED !== 'false'
const CLAUDE_PROVIDER_ID = 'anthropic-claude-cli'
const CLAUDE_CONNECTION_ID = 'claude-cli'
const CLAUDE_DISPLAY_NAME = 'Claude Code CLI (Pro/Max)'

/**
 * GET /api/models - List available AI models
 * Returns models from ProviderManager with metadata
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  // Authentication check
  if (!locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const include = url.searchParams.get('include')
    const connectionsOnly = include === 'connections'

    if (connectionsOnly) {
      const access = await resolveProviderAccess(locals.user?.id)
      const customProviders = await listCustomProviders(locals.user?.id)
      const localServers = await listLocalAiServers(locals.user?.id)
      const [codexStatus, claudeStatus] = await Promise.all([
        CODEX_PROVIDER_ENABLED ? detectCodexCliStatus() : Promise.resolve(null),
        CLAUDE_PROVIDER_ENABLED ? detectClaudeCliStatus() : Promise.resolve(null)
      ])
      const baseConnectionOptions = buildConnectionOptions(access, {
        codex: CODEX_PROVIDER_ENABLED ? codexStatus : null,
        claude: CLAUDE_PROVIDER_ENABLED ? claudeStatus : null,
        customProviders,
        localServers
      })
      const credentialTypes = gatherCredentialTypes(baseConnectionOptions.map((option) => option.id))
      const n8nStatusResult = await getN8NCredentialStatuses(credentialTypes, {
        userId: locals.user?.id
      })
      const connectionOptions = applyN8NStatuses(baseConnectionOptions, n8nStatusResult)

      return json({
        data: {
          connections: connectionOptions
        },
        success: true
      })
    }

    const refreshParam = url.searchParams.get('refresh')
    const forceRefresh = refreshParam === '1' || refreshParam === 'true'
    const catalog = await fetchVercelModelCatalog(forceRefresh)
    const access = await resolveProviderAccess(locals.user?.id)
    const customProviders = await listCustomProviders(locals.user?.id)
    const localServers = await listLocalAiServers(locals.user?.id)
    const enabledLocalServers = localServers.filter((server) => server.enabled !== false)
    const providerManager = new ProviderManager({
      apiKeys: access.apiKeys,
      gateway: {
        apiKey: access.gateway.apiKey ?? undefined,
        baseURL: access.gateway.baseURL ?? undefined
      },
      localProviders: enabledLocalServers
    })

    const [codexStatus, claudeStatus] = await Promise.all([
      CODEX_PROVIDER_ENABLED ? detectCodexCliStatus() : Promise.resolve(null),
      CLAUDE_PROVIDER_ENABLED ? detectClaudeCliStatus() : Promise.resolve(null)
    ])
    const supplementalModels: CatalogModel[] = []
    const localModels = await buildLocalCatalogModels(enabledLocalServers)
    supplementalModels.push(...localModels)

    if (CODEX_PROVIDER_ENABLED) {
      supplementalModels.push(...buildCodexCatalogModels())
    }
    if (CLAUDE_PROVIDER_ENABLED) {
      supplementalModels.push(...buildClaudeCliCatalogModels())
    }

    // Merge catalogs, preferring Vercel entries when duplicates exist
    const mergedModels = mergeCatalogs(catalog.models, supplementalModels)

    const category = url.searchParams.get('category')
    const filteredModels = category ? mergedModels.filter((m) => m.category === category) : mergedModels
    const defaultModel = filteredModels[0]?.id ?? mergedModels[0]?.id ?? 'anthropic/claude-3-5-sonnet-20241022'

    const configuredProviders = providerManager.getConfiguredProviders()
    const providerSummary = configuredProviders.map((provider) => ({
      name: provider,
      configured: true,
      info: providerManager.getProviderInfo(provider)
    }))

    if (CODEX_PROVIDER_ENABLED) {
      providerSummary.push({
        name: 'codex',
        configured: Boolean(codexStatus?.available),
        info: {
          models: ['codex/codex-cli'],
          features: {
            streaming: true,
            tools: true,
            reasoning: true,
            code: true,
            fast: true,
            vision: false,
            maxTokens: 200000
          },
        displayName: CODEX_DISPLAY_NAME,
          priority: 50
        }
      })
    }
    if (CLAUDE_PROVIDER_ENABLED) {
      providerSummary.push({
        name: 'claude-cli',
        configured: Boolean(claudeStatus?.available),
        info: {
          models: ['claude/claude-cli'],
          features: {
            streaming: true,
            tools: true,
            reasoning: true,
            code: true,
            fast: true,
            vision: false,
            maxTokens: 200000
          },
          displayName: CLAUDE_DISPLAY_NAME,
          priority: 50
        }
      })
    }

    const baseConnectionOptions = buildConnectionOptions(access, {
      codex: CODEX_PROVIDER_ENABLED ? codexStatus : null,
      claude: CLAUDE_PROVIDER_ENABLED ? claudeStatus : null,
      customProviders,
      localServers
    })
    const credentialTypes = gatherCredentialTypes(baseConnectionOptions.map((option) => option.id))
    const n8nStatusResult = await getN8NCredentialStatuses(credentialTypes, {
      userId: locals.user?.id
    })
    const connectionOptions = applyN8NStatuses(baseConnectionOptions, n8nStatusResult)

    // Return successful response
    // SECURITY: No API keys in response, only metadata
    return json({
      data: {
        models: filteredModels,
        default: defaultModel,
        total: filteredModels.length,
        providers: providerSummary,
        connections: connectionOptions,
        categories: ['fast', 'balanced', 'powerful', 'reasoning', 'code'],
        brain: 'Vercel AI SDK',
        fetchedAt: catalog.fetchedAt
      },
      success: true
    })
  } catch (error: any) {
    console.error('[Models API] Error listing models:', error)

    // SECURITY: Sanitize error messages - don't expose internals
    const sanitizedError = error.message?.includes('API')
      ? 'Failed to load model configuration'
      : error.message || 'An error occurred'

    return json({
      error: sanitizedError,
      success: false
    }, { status: 500 })
  }
}

function resolveTransport(entry: CatalogModel) {
  if (entry.transport) return entry.transport
  if (entry.connectionId === 'openrouter') return 'openrouter'
  if (entry.connectionId?.startsWith('direct:')) return 'local'
  if (entry.source === 'openrouter') return 'openrouter'
  if (entry.source === 'legacy' || entry.source === 'n8n-only') return 'local'
  return 'vercel-gateway'
}

function resolveConnectionId(entry: CatalogModel, transport: ReturnType<typeof resolveTransport>) {
  if (entry.connectionId) return entry.connectionId
  if (transport === 'openrouter') return 'openrouter'
  if (transport === 'local' || transport === 'direct') return `direct:${entry.provider}`
  return 'vercel-gateway'
}

function mergeCatalogs(vercelModels: CatalogModel[], supplementalModels: CatalogModel[]) {
  const merged = new Map<string, CatalogModel>()

  function upsert(entry: CatalogModel) {
    const canonicalId = entry.canonicalId ?? entry.id
    if (!canonicalId) return

    const transport = resolveTransport(entry)
    const connectionId = resolveConnectionId(entry, transport)
    const normalized: CatalogModel = {
      ...entry,
      source: entry.source ?? 'vercel',
      transport,
      canonicalId,
      connectionId,
      purpose: entry.purpose ?? 'chat'
    }

    const incomingConnections = new Set([
      ...(normalized.availableConnections ?? []),
      ...Object.keys(normalized.idVariants ?? {}),
      connectionId
    ].filter(Boolean) as string[])

    const existing = merged.get(canonicalId)
    if (!existing) {
      merged.set(canonicalId, {
        ...normalized,
        availableConnections: Array.from(incomingConnections)
      })
      return
    }

    const combinedVariants = {
      ...(existing.idVariants ?? {}),
      ...(normalized.idVariants ?? {})
    }
    const combinedConnections = new Set([
      ...(existing.availableConnections ?? []),
      ...incomingConnections,
      ...Object.keys(combinedVariants)
    ])

    merged.set(canonicalId, {
      ...existing,
      description: existing.description || normalized.description,
      pricing: existing.pricing || normalized.pricing,
      contextWindow: existing.contextWindow || normalized.contextWindow,
      maxOutputTokens: existing.maxOutputTokens || normalized.maxOutputTokens,
      features: existing.features || normalized.features,
      category: existing.category || normalized.category,
      tags: existing.tags?.length ? existing.tags : normalized.tags,
      upstreamProvider: existing.upstreamProvider ?? normalized.upstreamProvider,
      availableConnections: Array.from(combinedConnections),
      purpose: existing.purpose ?? normalized.purpose,
      idVariants: Object.keys(combinedVariants).length ? combinedVariants : existing.idVariants ?? normalized.idVariants
    })
  }

  for (const entry of vercelModels) {
    const transport = resolveTransport(entry)
    upsert({
      ...entry,
      source: entry.source ?? 'vercel',
      transport,
      connectionId: resolveConnectionId(entry, transport)
    })
  }

  for (const supplemental of supplementalModels) {
    const transport = supplemental.transport ?? 'local'
    upsert({
      ...supplemental,
      source: supplemental.source ?? 'local',
      transport,
      canonicalId: supplemental.canonicalId ?? supplemental.id,
      connectionId: resolveConnectionId(supplemental, transport)
    })
  }

  return Array.from(merged.values())
}

type LmStudioModelEntry = {
  id: string
  type?: string | null
  publisher?: string | null
  arch?: string | null
  compatibility_type?: string | null
  quantization?: string | null
  state?: string | null
  max_context_length?: number | null
  capabilities?: string[] | null
}

async function fetchLocalOpenAiModels(server: LocalAiServerSummary): Promise<string[]> {
  const baseUrl = (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')
  const openaiPath = server.openaiPath.replace(/\/+$/, '')
  const url = `${baseUrl}${openaiPath}/models`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      return []
    }
    const payload = await response.json().catch(() => null)
    const list = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : []

    return list
      .map((entry: any) => {
        if (!entry) return null
        if (typeof entry === 'string') return entry
        return entry.id || entry.name || entry.model || null
      })
      .filter((value: any): value is string => Boolean(value))
  } catch (error) {
    console.warn(`[Models API] Failed to list local models for ${server.id}:`, error)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchLmStudioModels(server: LocalAiServerSummary): Promise<LmStudioModelEntry[]> {
  const baseUrl = (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')
  const url = `${baseUrl}/api/v0/models`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      return []
    }
    const payload = await response.json().catch(() => null)
    const list = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : []

    return list
      .map((entry: any) => {
        if (!entry) return null
        const id = entry.id || entry.name || entry.model
        if (!id || typeof id !== 'string') return null
        const rawContext = entry.max_context_length
        const parsedContext =
          typeof rawContext === 'number'
            ? rawContext
            : typeof rawContext === 'string'
              ? Number(rawContext)
              : null
        return {
          id,
          type: entry.type ?? null,
          publisher: entry.publisher ?? null,
          arch: entry.arch ?? null,
          compatibility_type: entry.compatibility_type ?? null,
          quantization: entry.quantization ?? null,
          state: entry.state ?? null,
          max_context_length: Number.isFinite(parsedContext ?? NaN) ? parsedContext : null,
          capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : null
        } satisfies LmStudioModelEntry
      })
      .filter((value: LmStudioModelEntry | null): value is LmStudioModelEntry => Boolean(value))
  } catch (error) {
    console.warn(`[Models API] Failed to list LM Studio models:`, error)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function buildLocalPlaceholder(server: LocalAiServerSummary): CatalogModel {
  const canonicalId = `${server.id}/local-model`
  return {
    id: canonicalId,
    canonicalId,
    provider: server.id,
    name: 'local-model',
    displayName: `${server.label} (manual entry)`,
    description: `No models detected. Enter a ${server.label} model ID manually.`,
    tags: ['local', 'manual-entry'],
    features: { streaming: true },
    source: 'local',
    transport: 'local',
    connectionId: `direct:${server.id}`,
    availableConnections: [`direct:${server.id}`],
    upstreamProvider: 'local',
    purpose: 'chat'
  }
}

function normalizeLmStudioCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

function buildLmStudioFeatures(model: LmStudioModelEntry): Record<string, any> {
  const features: Record<string, any> = { streaming: true }
  const type = model.type?.toLowerCase()
  if (type === 'vlm' || type === 'vision') {
    features.vision = true
    features.image = true
  }

  const rawCaps = Array.isArray(model.capabilities) ? model.capabilities : []
  const caps = new Set(rawCaps.map((cap) => normalizeLmStudioCapability(cap)))
  if (caps.has('tools') || caps.has('tool') || caps.has('tool-calling') || caps.has('function-calling')) {
    features.tools = true
  }
  if (caps.has('vision') || caps.has('image') || caps.has('image-input')) {
    features.vision = true
    features.image = true
  }
  if (caps.has('json') || caps.has('json-mode') || caps.has('structured-output')) {
    features.jsonMode = true
  }
  if (caps.has('audio')) {
    features.audio = true
  }

  return features
}

function resolveLmStudioPurpose(model: LmStudioModelEntry): CatalogModel['purpose'] {
  const type = model.type?.toLowerCase()
  if (type === 'vlm' || type === 'vision') return 'visual'
  if (type === 'embedding' || type === 'embeddings') return 'utility'
  return 'chat'
}

function buildLmStudioTags(server: LocalAiServerSummary, model: LmStudioModelEntry): string[] {
  const tags = new Set<string>(['local', server.id])
  if (model.type) tags.add(model.type)
  if (model.publisher) tags.add(model.publisher)
  if (model.compatibility_type) tags.add(model.compatibility_type)
  if (model.quantization) tags.add(model.quantization)
  if (model.state) tags.add(model.state)
  if (model.arch) tags.add(model.arch)
  return Array.from(tags)
}

function buildLmStudioDescription(server: LocalAiServerSummary, model: LmStudioModelEntry): string {
  const parts = [model.publisher, model.quantization, model.state].filter(Boolean)
  const suffix = parts.length ? ` · ${parts.join(' · ')}` : ''
  return `${server.label} local model (${model.id})${suffix}`
}

async function buildLocalCatalogModels(servers: LocalAiServerSummary[]): Promise<CatalogModel[]> {
  const entries = await Promise.all(
    servers.map(async (server) => {
      if (server.supports.richMetadata) {
        const lmModels = await fetchLmStudioModels(server)
        if (lmModels.length) {
          return lmModels.map((model) => {
            const canonicalId = `${server.id}/${model.id}`
            const entry: CatalogModel = {
              id: canonicalId,
              canonicalId,
              provider: server.id,
              name: model.id,
              displayName: model.id,
              description: buildLmStudioDescription(server, model),
              tags: buildLmStudioTags(server, model),
              features: buildLmStudioFeatures(model),
              contextWindow:
                typeof model.max_context_length === 'number' ? model.max_context_length : undefined,
              source: 'local',
              transport: 'local',
              connectionId: `direct:${server.id}`,
              availableConnections: [`direct:${server.id}`],
              upstreamProvider: 'local',
              purpose: resolveLmStudioPurpose(model)
            }
            return entry
          })
        }
      }

      const modelIds = await fetchLocalOpenAiModels(server)
      if (!modelIds.length) {
        return [buildLocalPlaceholder(server)]
      }

      return modelIds.map((modelId) => {
        const canonicalId = `${server.id}/${modelId}`
        const displayName =
          server.id === 'llama-cpp' ? modelId.split('/').pop() ?? modelId : modelId
        const entry: CatalogModel = {
          id: canonicalId,
          canonicalId,
          provider: server.id,
          name: modelId,
          displayName,
          description: `${server.label} local model (${modelId})`,
          tags: ['local', server.id],
          features: { streaming: true },
          source: 'local',
          transport: 'local',
          connectionId: `direct:${server.id}`,
          availableConnections: [`direct:${server.id}`],
          upstreamProvider: 'local',
          purpose: 'chat'
        }
        return entry
      })
    })
  )

  return entries.flat()
}

function buildCodexCatalogModels(): CatalogModel[] {
  return [
    {
      id: 'codex/codex-cli',
      canonicalId: 'codex/codex-cli',
      provider: CODEX_PROVIDER_ID,
      upstreamProvider: 'openai',
      name: 'codex-cli',
      displayName: CODEX_DISPLAY_NAME,
      description:
        'Bridge CLI-agent chats through your logged-in Codex CLI session. Choose the actual GPT-5 variant in the Codex defaults panel.',
      tags: ['batshit-only', 'codex', 'openai'],
      features: {
        streaming: true,
        tools: true,
        reasoning: true,
        code: true,
        fast: true
      },
      category: 'code',
      purpose: 'chat',
      source: 'codex',
      transport: 'direct',
      connectionId: CODEX_CONNECTION_ID,
      availableConnections: [CODEX_CONNECTION_ID]
    }
  ]
}

function buildClaudeCliCatalogModels(): CatalogModel[] {
  return [
    {
      id: 'claude/claude-cli',
      canonicalId: 'claude/claude-cli',
      provider: CLAUDE_PROVIDER_ID,
      upstreamProvider: 'anthropic',
      name: 'claude-cli',
      displayName: CLAUDE_DISPLAY_NAME,
      description:
        'Bridge CLI-agent chats through your logged-in Claude Code CLI session. Choose the actual model in the Claude defaults panel.',
      tags: ['batshit-only', 'claude', 'anthropic'],
      features: {
        streaming: true,
        tools: true,
        reasoning: true,
        code: true,
        fast: true
      },
      category: 'code',
      purpose: 'chat',
      source: 'claude-cli',
      transport: 'direct',
      connectionId: CLAUDE_CONNECTION_ID,
      availableConnections: [CLAUDE_CONNECTION_ID]
    }
  ]
}

function buildConnectionOptions(
  access: ProviderAccessResolution,
  extras?: {
    codex: CodexCliStatus | null
    claude?: ClaudeCliStatus | null
    customProviders?: CustomProviderSummary[]
    localServers?: LocalAiServerSummary[]
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
    'minimax',
    'mimo',
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
    deepseek: 'DeepSeek',
    zai: 'Z.ai General',
    zai_coding: 'Z.ai Coding Plan',
    xai: 'xAI',
    moonshot: 'Moonshot AI',
    minimax: 'MiniMax',
    mimo: 'MiMo',
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
    minimax: 'Use MiniMax M-series models through the OpenAI-compatible MiniMax API.',
    mimo: 'Use Xiaomi MiMo V2.5 models through the OpenAI-compatible MiMo API.',
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
    addOption({
      id: `direct:${provider}`,
      label: `${providerLabel} (Direct)`,
      transport: 'direct',
      service: provider,
      providers: [provider],
      description: providerDescription,
      status: status?.hasKey ? 'ready' : 'locked',
      lockedReason: status?.hasKey ? undefined : lockedReason,
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
        status: 'ready',
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

  if (CODEX_PROVIDER_ENABLED) {
    const codexStatus = extras?.codex
    addOption({
      id: CODEX_CONNECTION_ID,
      label: CODEX_DISPLAY_NAME,
      transport: 'direct',
      service: CODEX_PROVIDER_ID,
      providers: [CODEX_PROVIDER_ID],
      description:
        'Use the Codex CLI tied to your ChatGPT Plus/Pro login for CLI agents. Supports CLI `--model` overrides (for example `gpt-5.1-codex`).',
      status: codexStatus?.available ? 'ready' : 'locked',
      lockedReason:
        codexStatus?.available
          ? undefined
          : codexStatus?.error ?? 'Codex CLI is not installed. Use the one-click install in Agent Settings, then run `codex login`.',
      setupCommand: codexStatus?.available ? undefined : codexStatus?.setupCommand,
      statusCommand: codexStatus?.statusCommand,
      setupContext: codexStatus?.setupContext,
      setupWorkingDirectory: codexStatus?.setupWorkingDirectory,
      n8nStatus: 'locked',
      n8nDescription: 'Codex CLI is only available for CLI primary agents.',
      requiredN8NCredentials: []
    })
  }

  if (CLAUDE_PROVIDER_ENABLED) {
    const claudeStatus = extras?.claude
    addOption({
      id: CLAUDE_CONNECTION_ID,
      label: CLAUDE_DISPLAY_NAME,
      transport: 'direct',
      service: CLAUDE_PROVIDER_ID,
      providers: [CLAUDE_PROVIDER_ID],
      description:
        'Use the Claude Code CLI tied to your Claude Pro/Max login for CLI agents.',
      status: claudeStatus?.available ? 'ready' : 'locked',
      lockedReason:
        claudeStatus?.available
          ? undefined
          : claudeStatus?.error ?? 'Claude Code CLI is not installed. Use the one-click install in Agent Settings, then run `claude auth login`.',
      setupCommand: claudeStatus?.available ? undefined : claudeStatus?.setupCommand,
      statusCommand: claudeStatus?.statusCommand,
      setupContext: claudeStatus?.setupContext,
      setupWorkingDirectory: claudeStatus?.setupWorkingDirectory,
      n8nStatus: 'locked',
      n8nDescription: 'Claude Code CLI is only available for CLI primary agents.',
      requiredN8NCredentials: []
    })
  }

  return options
}

function applyN8NStatuses(
  options: CatalogConnectionOption[],
  result: N8NCredentialStatusResult
): CatalogConnectionOption[] {
  if (!options.length) return options

  const detectionAvailable = result.available && Object.keys(result.statuses).length > 0
  const unavailableMessage = result.error || 'Set N8N_API_KEY to detect credentials automatically.'

  return options.map((option) => {
    if (option.id.startsWith('direct:custom_')) {
      return {
        ...option,
        requiredN8NCredentials: [],
        n8nStatus: 'locked',
        n8nDescription: 'Custom providers are only available in Batshit direct mode.'
      }
    }
    const required = CONNECTION_CREDENTIAL_MAP[option.id] ?? []
    let n8nStatus: CatalogConnectionOption['n8nStatus'] = option.n8nStatus ?? 'unknown'
    let n8nDescription = option.n8nDescription

    if (!required.length) {
      return {
        ...option,
        requiredN8NCredentials: option.requiredN8NCredentials ?? required,
        n8nStatus: detectionAvailable ? 'ready' : option.n8nStatus ?? 'unknown',
        n8nDescription: detectionAvailable ? 'No n8n credential required.' : unavailableMessage
      }
    }

    if (!detectionAvailable) {
      return {
        ...option,
        requiredN8NCredentials: required,
        n8nStatus: 'unknown',
        n8nDescription: unavailableMessage
      }
    }

    const missing = required.filter((credential) => !result.statuses[credential])
    const ready = missing.length === 0
    n8nStatus = ready ? 'ready' : 'locked'
    n8nDescription = ready
      ? 'Credential detected in n8n.'
      : `Missing n8n credential${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`

    return {
      ...option,
      requiredN8NCredentials: required,
      n8nStatus,
      n8nDescription
    }
  })
}

/**
 * POST /api/models/validate
 * Validate a specific model is available
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  // Authentication check
  if (!locals.user?.id) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const { modelId } = await request.json()

    if (!modelId) {
      return json(
        { error: 'Model ID required', success: false },
        { status: 400 }
      )
    }

    // Try to get the model
    try {
      const providerManager = await ProviderManager.createForUser(locals.user.id)
      const model = providerManager.getModel(modelId)
      return json({
        data: {
          available: true,
          modelId
        },
        success: true
      })
    } catch (modelError) {
      // Model not available, return fallback info
      logger.debug(`[Models API] Model ${modelId} not available, fallback may be used`)

      return json({
        data: {
          available: false,
          modelId,
          message: 'Model not available, fallback will be used'
        },
        success: true
      })
    }

  } catch (error: any) {
    console.error('[Models API] Validation error:', error)

    return json(
      {
        error: 'Validation failed',
        success: false
      },
      { status: 500 }
    )
  }
}
