/**
 * Model Listing API Endpoint
 * Story 5.3: Provider Management System
 *
 * Returns available AI models with metadata for UI population
 * SECURITY: Never expose API keys in responses
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { mergeCatalogVariantEvidence } from '$lib/utils/catalogReasoningEvidence'
import { apiFailure } from '$lib/server/services/apiResponses'
import { logger } from '$lib/utils/logger'
import {
  ProviderManager,
  resolveProviderAccess,
  type ProviderAccessResolution
} from '$lib/server/services/providers'
import { fetchVercelModelCatalog } from '$lib/server/services/vercelModelCatalog'
import type {
  CatalogModel,
  CatalogConnectionOption,
  LocalContextReading
} from '$lib/types/modelCatalog'
import { CONNECTION_CREDENTIAL_MAP, gatherCredentialTypes } from '$lib/server/constants/modelConnections'
import { getN8NCredentialStatuses, type N8NCredentialStatusResult } from '$lib/server/services/n8nCredentials'
import { listCustomProviders } from '$lib/server/services/customProviders'
import { listLocalAiServers, resolveLocalAiRuntimeBaseUrl } from '$lib/server/services/localAiServers'
import { readKoboldCppServing } from '$lib/server/services/localRuntimeContext'
import type { LocalAiServerSummary } from '$lib/types/localAi'
import { buildConnectionOptions as projectConnectionOptions } from '$lib/server/services/modelConnectionOptions'
import { pausedPlanStatuses } from '$lib/server/services/pausedPlans'
import { chatgptPlanConnectionOptions, chatgptPlanCatalogModels } from '$lib/server/services/chatgptPlanCatalog'
import { claudePlanConnectionOptions, claudePlanCatalogModels } from '$lib/server/services/claudePlanCatalog'
import { readClaudePlanDisplayStatus } from '$lib/server/services/claudePlanReadiness'
import { isClaudePlanConnection } from '$lib/utils/claudePlanConnection'
import { isChatgptPlanConnection } from '$lib/utils/chatgptPlanConnection'
import { readOllamaModelCapabilities } from '$lib/utils/ollamaModelCapabilities'

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
      const claudePlanStatus = await readClaudePlanDisplayStatus()
      const baseConnectionOptions = buildConnectionOptions(access, {
        customProviders,
        localServers,
        pausedPlans: await pausedPlanStatuses()
      })
      const credentialTypes = gatherCredentialTypes(baseConnectionOptions.map((option) => option.id))
      const n8nStatusResult = await getN8NCredentialStatuses(credentialTypes, {
        userId: locals.user?.id
      })
      const connectionOptions = [...applyN8NStatuses(baseConnectionOptions, n8nStatusResult), ...chatgptPlanConnectionOptions(locals.user.id),
        ...claudePlanConnectionOptions(claudePlanStatus)]

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

    const claudePlanReadiness = await readClaudePlanDisplayStatus()
    const supplementalModels: CatalogModel[] = []
    const localModels = await buildLocalCatalogModels(enabledLocalServers)
    supplementalModels.push(...localModels)

    // Merge catalogs, preferring Vercel entries when duplicates exist
    // SA-139: the Claude plan's status is its own check (the qualified executable and a Claude plan
    // sign-in), shared for a short while with the card and the saved presets (`readClaudePlanDisplayStatus`).
    const mergedModels = [...mergeCatalogs(catalog.models, supplementalModels), ...await chatgptPlanCatalogModels(locals.user.id),
      ...claudePlanCatalogModels(claudePlanReadiness)]

    const category = url.searchParams.get('category')
    const filteredModels = category ? mergedModels.filter((m) => m.category === category) : mergedModels
    const defaultModel = filteredModels[0]?.id ?? mergedModels[0]?.id ?? 'anthropic/claude-sonnet-4-5'

    const configuredProviders = providerManager.getConfiguredProviders()
    const providerSummary = configuredProviders.map((provider) => ({
      name: provider,
      configured: true,
      info: providerManager.getProviderInfo(provider)
    }))

    const baseConnectionOptions = buildConnectionOptions(access, {
      customProviders,
      localServers,
      pausedPlans: await pausedPlanStatuses()
    })
    const credentialTypes = gatherCredentialTypes(baseConnectionOptions.map((option) => option.id))
    const n8nStatusResult = await getN8NCredentialStatuses(credentialTypes, {
      userId: locals.user?.id
    })
    const connectionOptions = [...applyN8NStatuses(baseConnectionOptions, n8nStatusResult), ...chatgptPlanConnectionOptions(locals.user.id),
      ...claudePlanConnectionOptions(claudePlanReadiness)]

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

    const combinedVariants = { ...(existing.idVariants ?? {}) }
    for (const [connection, variant] of Object.entries(normalized.idVariants ?? {})) {
      combinedVariants[connection] = mergeCatalogVariantEvidence(combinedVariants[connection], variant, connection)
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
  /** SA-102 P4: what the model is loaded WITH, not its ceiling. */
  loaded_context_length?: number | null
  /** Absent when the model was loaded without a TTL. */
  remaining_ttl_seconds?: number | null
  is_loaded?: boolean
  /** DL-102-11: open-ended text as the program reports it. */
  format?: string | null
  display_name?: string | null
  params_string?: string | null
  size_bytes?: number | null
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

/**
 * SA-102 P4 (DL-102-04): read what LM Studio is ACTUALLY running, not just the
 * model's ceiling.
 *
 * `/api/v1/models` (LM Studio 0.4+) is materially richer than the `/api/v0`
 * endpoint Batshit used to call. Verified live on 0.4.23, 2026-09-02:
 *
 *   max_context_length: 262144                     <- the ceiling
 *   loaded_instances[0].config.context_length: 208384   <- what it is running
 *   format: "mlx"                                  <- GGUF vs MLX, DL-102-11
 *   display_name: "Qwen3.8 27B"                    <- human-readable
 *   capabilities: { vision, trained_for_tool_use, reasoning: {...} }
 *
 * Three shapes that a naive reader gets wrong, all seen on Josh's machine:
 *   - `loaded_instances` is EMPTY until the model is loaded. That is
 *     "unknown until loaded", not "use the ceiling".
 *   - `remaining_ttl_seconds` is ABSENT when the model was loaded without a
 *     TTL. Optional, not merely transient.
 *   - `capabilities` can be absent entirely (the embedding model row has no
 *     such key) as well as `null`.
 *
 * `/api/v0/models` remains the fallback for older LM Studio builds.
 */
async function fetchLmStudioModels(server: LocalAiServerSummary): Promise<LmStudioModelEntry[]> {
  const baseUrl = (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')

  const v1 = await fetchLmStudioModelList(`${baseUrl}/api/v1/models`)
  if (v1.length) return v1

  return fetchLmStudioModelList(`${baseUrl}/api/v0/models`)
}

async function fetchLmStudioModelList(url: string): Promise<LmStudioModelEntry[]> {
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
        // v1 keys on `key`; v0 keys on `id`.
        const id = entry.key || entry.id || entry.name || entry.model
        if (!id || typeof id !== 'string') return null

        const loadedInstance = Array.isArray(entry.loaded_instances)
          ? entry.loaded_instances.find((instance: any) => instance && typeof instance === 'object')
          : null

        return {
          id,
          type: entry.type ?? null,
          publisher: entry.publisher ?? null,
          // v1 renames `arch` to `architecture`.
          arch: entry.architecture ?? entry.arch ?? null,
          compatibility_type: entry.compatibility_type ?? null,
          // v0 gives a string; v1 gives `{ name, bits_per_weight }`.
          quantization: normalizeLmStudioQuantization(entry.quantization),
          state: entry.state ?? null,
          max_context_length: coerceFiniteNumber(entry.max_context_length),
          loaded_context_length: coerceFiniteNumber(loadedInstance?.config?.context_length),
          // Absent when the model was loaded without a TTL — optional, not just transient.
          remaining_ttl_seconds: coerceFiniteNumber(loadedInstance?.remaining_ttl_seconds),
          is_loaded: Boolean(loadedInstance),
          // DL-102-11: open-ended text, never a two-value enum.
          format: typeof entry.format === 'string' && entry.format.trim() ? entry.format.trim() : null,
          display_name:
            typeof entry.display_name === 'string' && entry.display_name.trim()
              ? entry.display_name.trim()
              : null,
          params_string:
            typeof entry.params_string === 'string' && entry.params_string.trim()
              ? entry.params_string.trim()
              : null,
          size_bytes: coerceFiniteNumber(entry.size_bytes),
          // v0 gives a loose string array; v1 gives a structured object that may
          // be null OR absent. Both shapes are normalized to a flat name list.
          capabilities: normalizeLmStudioCapabilities(entry.capabilities)
        } satisfies LmStudioModelEntry
      })
      .filter((value: LmStudioModelEntry | null): value is LmStudioModelEntry => Boolean(value))
  } catch (error) {
    console.warn(`[Models API] Failed to list LM Studio models from ${url}:`, error)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeLmStudioQuantization(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (value && typeof value === 'object') {
    const name = (value as any).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return null
}

/**
 * v0: `["tool_use", "vision"]`. v1: `{ vision: true, trained_for_tool_use: true,
 * reasoning: { allowed_options, default } }`, which may be `null` or missing.
 */
function normalizeLmStudioCapabilities(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (!value || typeof value !== 'object') return null

  const names: string[] = []
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === true) names.push(key)
    else if (raw && typeof raw === 'object') names.push(key)
  }
  return names.length ? names : null
}

/**
 * SA-102 P4 (DL-102-04): Ollama's effective context.
 *
 * `GET /api/ps` reports `context_length` for each LOADED model — the honest
 * read of what a prompt is actually being measured against (verified live:
 * `llama3.2:latest` at 131072 on Josh's Mac). It is only available while the
 * model is loaded. `/api/show` gives the model's own maximum, which is a
 * different number and must be labelled as such.
 *
 * Ollama's `/v1` endpoint cannot set `num_ctx` at all, and it TRUNCATES a
 * prompt that exceeds the loaded context from the front, silently — no error,
 * no warning, nothing in the response. That is the single worst failure mode in
 * this story, and it is also a cache miss on every later turn.
 */
async function fetchOllamaContextReadings(
  server: LocalAiServerSummary
): Promise<Map<string, LocalContextReading>> {
  const baseUrl = (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')
  const readings = new Map<string, LocalContextReading>()

  const loaded = await fetchJsonWithTimeout(`${baseUrl}/api/ps`)
  const loadedList = Array.isArray(loaded?.models) ? loaded.models : []
  for (const entry of loadedList) {
    const name = typeof entry?.name === 'string' ? entry.name : typeof entry?.model === 'string' ? entry.model : null
    const contextLength = coerceFiniteNumber(entry?.context_length)
    if (!name || contextLength === null) continue
    readings.set(name, {
      source: 'loaded',
      loadedContextWindow: contextLength,
      maxContextWindow: null,
      remainingTtlSeconds: null
    })
  }

  return readings
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 4000): Promise<any | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * SA-102 P4 (DL-102-04): turn an LM Studio row into an honest context reading.
 * An empty `loaded_instances` means "unknown until loaded" — never the ceiling.
 */
function buildLmStudioContextReading(model: LmStudioModelEntry): LocalContextReading {
  if (model.is_loaded && typeof model.loaded_context_length === 'number') {
    return {
      source: 'loaded',
      loadedContextWindow: model.loaded_context_length,
      maxContextWindow: model.max_context_length ?? null,
      remainingTtlSeconds: model.remaining_ttl_seconds ?? null
    }
  }
  return {
    source: 'unknown-until-loaded',
    loadedContextWindow: null,
    maxContextWindow: model.max_context_length ?? null,
    remainingTtlSeconds: null
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
              displayName: model.display_name || model.id,
              description: buildLmStudioDescription(server, model),
              tags: buildLmStudioTags(server, model),
              features: buildLmStudioFeatures(model),
              contextWindow:
                typeof model.max_context_length === 'number' ? model.max_context_length : undefined,
              // SA-102 P4 (DL-102-04): what it is running with, separately from
              // the ceiling above, and honestly absent when it is not loaded.
              localContext: buildLmStudioContextReading(model),
              format: model.format ?? null,
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

      // SA-102 P4: Ollama is the one plain-list runtime that can tell us what a
      // loaded model is actually running with.
      // One native bulk metadata read, independently of model count. Preserve
      // the configured /v1 discovery IDs; never guess aliases or fan out /show.
      const [ollamaContext, ollamaCapabilities] = server.id === 'ollama'
        ? await Promise.all([
            fetchOllamaContextReadings(server),
            fetchJsonWithTimeout(`${(resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, '')}/api/tags`)
              .then(readOllamaModelCapabilities)
          ])
        : [null, null]
      // BL-101 / SA-124 P4: KoboldCpp reports the size it was started with, and
      // a model switch can change it. It lists only the model it is serving.
      // BL-104: it answers EVERY request with that model, whatever the request
      // names, so that row is marked for the preset editor.
      const kobold =
        server.id === 'koboldcpp'
          ? await readKoboldCppServing(
              (resolveLocalAiRuntimeBaseUrl(server.baseUrl) ?? server.baseUrl).replace(/\/+$/, ''),
              modelIds
            )
          : null

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
          features: { streaming: true, ...ollamaCapabilities?.get(modelId) },
          source: 'local',
          transport: 'local',
          connectionId: `direct:${server.id}`,
          availableConnections: [`direct:${server.id}`],
          upstreamProvider: 'local',
          purpose: 'chat',
          localContext: ollamaContext
            ? (ollamaContext.get(modelId) ?? {
                // Ollama CAN report this, but only while the model is loaded.
                // "Not loaded" is a state, not the ceiling and not an error.
                source: 'unknown-until-loaded',
                loadedContextWindow: null,
                maxContextWindow: null,
                remainingTtlSeconds: null
              })
            : (kobold?.context ?? null)
        }
        if (kobold?.servedModelId === modelId) {
          entry.servesEveryRequest = true
        }
        return entry
      })
    })
  )

  return entries.flat()
}

function buildConnectionOptions(access: ProviderAccessResolution, extras?: Parameters<typeof projectConnectionOptions>[1]) {
  return projectConnectionOptions(access, extras)
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

    // SA-139: a plan model (ChatGPT or Claude) runs only through its own connection and never falls
    // back, so ProviderManager is not asked about it; the connection's status says whether it can run.
    const connectionId = String(modelId).split('/')[0]
    if (isClaudePlanConnection(connectionId) || isChatgptPlanConnection(connectionId)) {
      return json({ data: { available: false, modelId,
        message: 'Plan models are not checked here: they run only through their own connection and never fall back to another one. See that connection in Settings → Models.' }, success: true })
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

/** Test seam: the local program rows `/api/models` adds to the catalog. */
export {
  buildLocalCatalogModels as _buildLocalCatalogModels,
  mergeCatalogs as _mergeCatalogs,
  buildConnectionOptions as _buildConnectionOptions
}
