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
import type {
  CatalogModel,
  CatalogConnectionOption,
  LocalContextReading
} from '$lib/types/modelCatalog'
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
      const ollamaContext =
        server.id === 'ollama' ? await fetchOllamaContextReadings(server) : null

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
            : null
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
