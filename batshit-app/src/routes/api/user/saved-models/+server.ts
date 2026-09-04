import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { type SavedModel, isTieredPricing, type ModelConnectionInfo, type ImageTransport, type ModelPurpose } from '$lib/types/savedModels'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { determineModelCompatibility } from '$lib/data/model-compatibility-registry'
import { ProviderManager, type ModelInfo } from '$lib/server/services/providers'
import {
  providerFeaturesToCapabilities,
  mergeCapabilities,
  normaliseModelSettings
} from '$lib/server/services/modelManagerHelpers'
import {
  inferLiveKitSpeechToSpeechConfig,
  normalizeModelVoiceSessionConfig
} from '$lib/utils/modelVoiceSession'
import {
  fetchVercelModelCatalog,
  findVercelCatalogEntry,
  findVercelCatalogEntryById
} from '$lib/server/services/vercelModelCatalog'
import { inferModelPurpose } from '$lib/utils/modelPurpose'
import { resolveCatalogIds, resolveModelIds } from '$lib/utils/modelIdResolver'
import { resolveSavedModelConnection } from '$lib/utils/modelConnections'
import { LOCAL_AI_SERVER_IDS } from '$lib/data/localAiServers'

class ModelPresetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelPresetValidationError'
  }
}

async function findModelPresetAgentReferences(userId: string, modelId: string) {
  const agents = await redis.getAgents(userId)
  return agents
    .flatMap((agent) => {
      const references: Array<{ agentId: string; agentName: string; field: 'primary' | 'fallback' }> = []
      const agentName = agent.displayName || (agent as Record<string, any>).name || agent.id
      if (agent.primary_model_preset_id === modelId) {
        references.push({ agentId: agent.id, agentName, field: 'primary' })
      }
      if (agent.fallback_model_preset_id === modelId) {
        references.push({ agentId: agent.id, agentName, field: 'fallback' })
      }
      return references
    })
}

function formatModelPresetReferenceMessage(
  references: Array<{ agentName: string; field: 'primary' | 'fallback' }>
) {
  const names = references
    .slice(0, 4)
    .map((reference) => `${reference.agentName} (${reference.field})`)
  const suffix = references.length > names.length ? ` and ${references.length - names.length} more` : ''
  return `This model preset is still used by ${names.join(', ')}${suffix}. Choose a different model for those agents before deleting it.`
}

async function getProviderModel(
  manager: ProviderManager,
  modelId?: string | null,
  provider?: string,
  catalogModelId?: string | null
) {
  if (!modelId) return null

  const vercelMatch =
    (await findVercelCatalogEntryById(catalogModelId)) ??
    (await findVercelCatalogEntry(provider, modelId))

  if (vercelMatch) {
    return {
      id: vercelMatch.id,
      name: vercelMatch.name,
      provider: vercelMatch.provider,
      displayName: vercelMatch.displayName,
      features: vercelMatch.features,
      category: vercelMatch.category
    } satisfies ModelInfo
  }

  const catalog = manager.listAvailableModels()
  const targetId = provider ? `${provider}/${modelId}` : undefined

  return (
    (catalogModelId ? catalog.find((model) => model.id === catalogModelId) : null) ||
    (targetId ? catalog.find((model) => model.id === targetId) : null) ||
    catalog.find((model) => model.provider === provider && model.name === modelId) ||
    null
  )
}

function resolveConnectionId(connection: ModelConnectionInfo): string | null {
  const explicit = connection.id?.trim()
  if (explicit) return explicit
  if (connection.type === 'vercel-gateway') return 'vercel-gateway'
  if (connection.type === 'openrouter') return 'openrouter'
  const service = connection.service?.trim()
  return service ? `direct:${service}` : null
}

function resolveCatalogPresetIdentity(
  catalogEntry: Awaited<ReturnType<typeof findVercelCatalogEntryById>>,
  connection: ModelConnectionInfo
) {
  if (!catalogEntry) return null
  const connectionId = resolveConnectionId(connection)
  if (!connectionId) {
    throw new ModelPresetValidationError(
      'This catalog model is missing a provider connection. Select the connection again before saving.'
    )
  }

  const identity = resolveCatalogIds({
    connectionId,
    connection: {
      id: connectionId,
      transport: connection.type,
      service: connection.service,
      providers: connection.service ? [connection.service] : undefined
    },
    developerId: catalogEntry.provider,
    modelId: catalogEntry.name,
    idVariants: catalogEntry.idVariants ?? null
  })

  if (!identity?.source) {
    throw new ModelPresetValidationError(
      `The Model Catalog does not have an exact provider identifier for ${connectionId}. Refresh the catalog before saving this preset.`
    )
  }

  return identity
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeImageTransport(value: unknown): ImageTransport | undefined {
  if (value === 'auto' || value === 'url') {
    return value
  }
  return undefined
}

function normalizeModelPurpose(value: unknown): ModelPurpose | null {
  return value === 'chat' || value === 'visual' || value === 'audio' || value === 'utility'
    ? value
    : null
}

function stripInternalModelSettings(settings: SavedModel['settings'] | undefined): SavedModel['settings'] | undefined {
  if (!settings || typeof settings !== 'object') return settings
  const next = { ...settings }
  delete next.voiceSession
  return Object.keys(next).length > 0 ? next : undefined
}

async function normaliseSavedModel(payload: SavedModel, manager: ProviderManager): Promise<SavedModel> {
  const trimmedName = payload.modelName?.trim() || ''
  let trimmedProvider = payload.provider?.trim() || ''
  let trimmedModelId = payload.modelId?.trim() || ''
  const rawId = typeof payload.id === 'string' ? payload.id.trim() : ''
  const resolvedConnection = normalizeConnection(payload.connection, trimmedProvider, payload.isVercelImport)
  const requestedCatalogModelId =
    payload.catalogModelId?.trim() || payload.vercelSourceId?.trim() || undefined
  const catalogEntry = requestedCatalogModelId
    ? await findVercelCatalogEntryById(requestedCatalogModelId)
    : null

  if (requestedCatalogModelId && !catalogEntry) {
    throw new ModelPresetValidationError(
      'This catalog model is no longer available. Refresh the Model Catalog and choose it again.'
    )
  }

  const catalogIdentity = resolveCatalogPresetIdentity(catalogEntry, resolvedConnection)
  // Local IDs are opaque provider targets. A previous save splits an owner
  // prefix into developer/model fields, so a settings-only edit must retain
  // the exact target. Reject stale effective IDs when identity fields change.
  const submittedEffectiveId = payload.effectiveModelId?.trim()
  const preservedLocalEffectiveId =
    resolvedConnection.type === 'direct' &&
    (LOCAL_AI_SERVER_IDS as ReadonlySet<string>).has(resolvedConnection.service ?? '') &&
    (submittedEffectiveId === trimmedModelId ||
      submittedEffectiveId === `${trimmedProvider}/${trimmedModelId}`)
      ? submittedEffectiveId
      : undefined
  const manualIdentity = catalogIdentity
    ? null
    : resolveModelIds({
        developerId: trimmedProvider,
        modelId: trimmedModelId,
        effectiveModelId: preservedLocalEffectiveId,
        connection: resolvedConnection
      })

  if (catalogIdentity) {
    trimmedProvider = catalogIdentity.developerId
    trimmedModelId = catalogIdentity.modelId
  } else if (manualIdentity) {
    trimmedProvider = manualIdentity.developerId
    trimmedModelId = manualIdentity.modelId
  }

  const effectiveModelId =
    catalogIdentity?.effectiveModelId ?? manualIdentity?.effectiveModelId ?? ''
  if (!trimmedProvider || !trimmedModelId || !effectiveModelId) {
    throw new ModelPresetValidationError(
      'Developer ID and Model ID are required to save a model preset.'
    )
  }

  const generatedId =
    rawId ||
    buildModelPresetId({
      displayName: trimmedName,
      modelId: trimmedModelId,
      provider: trimmedProvider,
      connection: resolvedConnection
    }) ||
    `model_${Date.now()}`
  const catalogModelId = catalogEntry?.id
  const isVercelImport = resolvedConnection.type === 'vercel-gateway' && Boolean(catalogEntry)
  const vercelSourceId = isVercelImport ? catalogModelId : undefined

  const vercelCatalogEntry =
    catalogEntry ??
    (trimmedProvider && trimmedModelId
      ? await findVercelCatalogEntry(trimmedProvider, trimmedModelId)
      : null)

  const inferredPurpose =
    normalizeModelPurpose(vercelCatalogEntry?.purpose) ??
    inferModelPurpose({
      id:
        vercelCatalogEntry?.id ??
        vercelSourceId ??
        (trimmedProvider && trimmedModelId ? `${trimmedProvider}/${trimmedModelId}` : trimmedModelId),
      name: vercelCatalogEntry?.name || trimmedModelId || trimmedName,
      modelType: vercelCatalogEntry?.modelType ?? null,
      tags: vercelCatalogEntry?.tags ?? null
    })
  const purposeOverride = normalizeModelPurpose(payload.purposeOverride)
  const purpose = purposeOverride ?? inferredPurpose

  const model: SavedModel = {
    ...payload,
    id: generatedId,
    modelName: trimmedName || trimmedModelId || generatedId,
    modelId: trimmedModelId,
    provider: trimmedProvider,
    catalogModelId,
    effectiveModelId,
    purpose,
    purposeOverride: purposeOverride ?? undefined,
    contextWindow: toNumber(payload.contextWindow) ?? 0,
    pricing: payload.pricing ?? { input: 0, output: 0 },
    settings: stripInternalModelSettings(payload.settings) ?? {},
    isVercelImport,
    vercelSourceId,
    voiceSession:
      normalizeModelVoiceSessionConfig(payload.voiceSession) ??
      normalizeModelVoiceSessionConfig(payload.settings?.voiceSession) ??
      inferLiveKitSpeechToSpeechConfig(trimmedProvider, trimmedModelId),
    compatibility: determineModelCompatibility(trimmedProvider),
    connection: resolvedConnection,
    imageTransport: normalizeImageTransport(payload.imageTransport)
  }

  const providerModel: ModelInfo | null = await getProviderModel(
    manager,
    model.modelId,
    model.provider,
    model.catalogModelId
  )
  const providerCapabilities = providerFeaturesToCapabilities(providerModel?.features)

  model.capabilities = mergeCapabilities(providerCapabilities, payload.capabilities)
  model.vercelDisplayName = providerModel?.displayName ?? payload.vercelDisplayName

  if (model.enrichment) {
    if (model.enrichment.contextWindow !== undefined) {
      model.enrichment.contextWindow = toNumber(model.enrichment.contextWindow)
    }
    if (model.enrichment.pricing) {
      model.enrichment.pricing.input = toNumber(model.enrichment.pricing.input)
      model.enrichment.pricing.output = toNumber(model.enrichment.pricing.output)
      model.enrichment.pricing.cachedInput = toNumber(model.enrichment.pricing.cachedInput)
    }
  }

  if (model.pricing) {
    if (!isTieredPricing(model.pricing.input)) {
      model.pricing.input = toNumber(model.pricing.input) ?? 0
    }
    model.pricing.output = toNumber(model.pricing.output) ?? 0
    if (model.pricing.cachedInput !== undefined) {
      model.pricing.cachedInput = toNumber(model.pricing.cachedInput)
    }
  }

  model.settings = normaliseModelSettings({
    settings: model.settings ?? undefined,
    provider: model.provider,
    connection: model.connection,
    modelId: model.modelId,
    vercelId: model.catalogModelId ?? model.vercelSourceId ?? undefined,
    capabilities: model.capabilities ?? null,
    purpose: model.purpose ?? null
  }) ?? undefined

  return model
}

function normalizeConnection(
  connection: ModelConnectionInfo | undefined,
  provider: string,
  isVercelImport?: boolean
): ModelConnectionInfo {
  if (connection?.type) {
    return {
      id: connection.id,
      type: connection.type,
      service: connection.service ?? (connection.type === 'direct' ? provider : connection.service),
      useDeveloperPrefix: connection.useDeveloperPrefix ?? false
    }
  }

  if (isVercelImport) {
    return {
      type: 'vercel-gateway',
      service: 'vercel'
    }
  }

  return {
    type: 'direct',
    service: provider
  }
}

function buildModelPresetId(options: {
  displayName?: string
  modelId?: string
  provider?: string
  connection?: ModelConnectionInfo | null
}): string {
  const displayName = options.displayName?.trim() || ''
  const modelId = options.modelId?.trim() || ''
  const provider = options.provider?.trim() || ''
  const connection = options.connection ?? null

  const namePart = sanitizeId(displayName || modelId)
  const connectionType = connection?.type || ''
  const connectionService = connection?.service || ''
  const identityPart = sanitizeId(
    [provider, modelId, connectionType, connectionService].filter(Boolean).join('_')
  )

  if (namePart && identityPart && namePart !== identityPart) {
    return `${namePart}_${identityPart}`
  }
  return namePart || identityPart
}

async function loadUserModelsWithPurge(userId: string, vercelIds: Set<string>) {
  const modelIds = await redis.sMembers(`user:${userId}:models`)
  if (!modelIds.length) {
    return { models: [], purged: [] as { id: string; modelName: string }[] }
  }

  const models: SavedModel[] = []
  for (const modelId of modelIds) {
    const record = (await redis.get(`model:${modelId}`)) as SavedModel | null
    if (record) {
      models.push(record)
    }
  }

  const purged: { id: string; modelName: string }[] = []
  const filtered: SavedModel[] = []
  for (const model of models) {
    if (model.isVercelImport && model.vercelSourceId && !vercelIds.has(model.vercelSourceId)) {
      await redis.del(`model:${model.id}`)
      await redis.sRem(`user:${userId}:models`, model.id)
      purged.push({ id: model.id, modelName: model.modelName })
      continue
    }
    filtered.push(model)
  }

  filtered.sort(
    (a, b) =>
      new Date(b.createdAt || b.updatedAt || 0).getTime() -
      new Date(a.createdAt || a.updatedAt || 0).getTime()
  )

  return { models: filtered, purged }
}

function repairSavedModelIdentity(
  model: SavedModel,
  catalogEntry: Awaited<ReturnType<typeof findVercelCatalogEntryById>>
) {
  const connection = resolveSavedModelConnection(model)
  let changed = false

  const connectionId = resolveConnectionId(connection)
  const hasCatalogVariant = Boolean(
    connectionId && catalogEntry?.idVariants?.[connectionId]
  )
  if (catalogEntry && hasCatalogVariant) {
    const identity = resolveCatalogPresetIdentity(catalogEntry, connection)
    if (identity) {
      if (model.catalogModelId !== catalogEntry.id) {
        model.catalogModelId = catalogEntry.id
        changed = true
      }
      if (model.provider !== identity.developerId) {
        model.provider = identity.developerId
        changed = true
      }
      if (model.modelId !== identity.modelId) {
        model.modelId = identity.modelId
        changed = true
      }
      if (model.effectiveModelId !== identity.effectiveModelId) {
        model.effectiveModelId = identity.effectiveModelId
        changed = true
      }
    }
  }

  if (!model.effectiveModelId) {
    const identity = resolveModelIds({
      developerId: model.provider,
      modelId: model.modelId,
      connection
    })
    if (identity?.effectiveModelId) {
      model.effectiveModelId = identity.effectiveModelId
      changed = true
    }
  }

  return changed
}

function repairSavedModelPurpose(
  model: SavedModel,
  catalogEntry: Awaited<ReturnType<typeof findVercelCatalogEntryById>>
) {
  const purposeOverride = normalizeModelPurpose(model.purposeOverride)
  const nextPurpose =
    purposeOverride ??
    normalizeModelPurpose(catalogEntry?.purpose) ??
    inferModelPurpose({
      id:
        catalogEntry?.id ??
        model.catalogModelId ??
        model.vercelSourceId ??
        (model.provider && model.modelId ? `${model.provider}/${model.modelId}` : model.modelId),
      name: catalogEntry?.name ?? model.modelId ?? model.modelName,
      modelType: catalogEntry?.modelType ?? null,
      tags: catalogEntry?.tags ?? null
    })

  if (model.purpose === nextPurpose) return false
  model.purpose = nextPurpose
  return true
}

// GET /api/user/saved-models
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const catalog = await fetchVercelModelCatalog()
    const vercelIds = new Set(
      catalog.models.filter((entry) => entry.source === 'vercel').map((entry) => entry.id)
    )
    const { models, purged } = await loadUserModelsWithPurge(locals.user.id, vercelIds)

    const catalogLookup = new Map<string, (typeof catalog.models)[number]>()
    for (const entry of catalog.models) {
      const id = entry.id?.toLowerCase()
      if (id) catalogLookup.set(id, entry)
      const canonicalId = entry.canonicalId?.toLowerCase()
      if (canonicalId) catalogLookup.set(canonicalId, entry)
      const providerKey = entry.provider && entry.name ? `${entry.provider}/${entry.name}`.toLowerCase() : null
      if (providerKey) catalogLookup.set(providerKey, entry)
    }

    let purposeBackfilledCount = 0
    let identityBackfilledCount = 0
    for (const model of models) {
      const lookupKey =
        model.catalogModelId?.toLowerCase() ||
        model.vercelSourceId?.toLowerCase() ||
        (model.provider && model.modelId ? `${model.provider}/${model.modelId}`.toLowerCase() : null)
      const match = lookupKey ? catalogLookup.get(lookupKey) ?? null : null
      const identityChanged = repairSavedModelIdentity(model, match)
      if (identityChanged) {
        identityBackfilledCount += 1
      }
      const purposeChanged = repairSavedModelPurpose(model, match)
      if (purposeChanged) {
        purposeBackfilledCount += 1
      }
      if (identityChanged || purposeChanged) {
        await redis.set(`model:${model.id}`, model)
      }
    }

    return json({
      models,
      meta: {
        purged,
        purposeBackfilledCount,
        identityBackfilledCount,
        vercelCatalogCount: vercelIds.size,
        vercelCatalogFetchedAt: catalog.fetchedAt
      }
    })
  } catch (error) {
    console.error('Failed to load saved models:', error)
    return json({ error: 'Failed to load saved models' }, { status: 500 })
  }
}

export {
  normaliseSavedModel as _normaliseSavedModel,
  loadUserModelsWithPurge as _loadUserModelsWithPurge,
  repairSavedModelPurpose as _repairSavedModelPurpose
}

// POST /api/user/saved-models
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const providerManager = await ProviderManager.createForUser(locals.user.id)
    const payload = (await request.json()) as SavedModel
    const model = await normaliseSavedModel(payload, providerManager)

    const now = new Date().toISOString()
    model.createdAt = model.createdAt || now
    model.updatedAt = now

    const setKey = `user:${locals.user.id}:models`
    const isOwned = await redis.sismember(setKey, model.id)
    const exists = await redis.exists(`model:${model.id}`)
    if (exists && !isOwned) {
      return json(
        { error: 'A model preset with that display name already exists. Choose a different display name.' },
        { status: 400 }
      )
    }

    await redis.set(`model:${model.id}`, model)
    await redis.sAdd(setKey, model.id)

    return json({ success: true, model })
  } catch (error) {
    console.error('Failed to save model:', error)
    if (error instanceof ModelPresetValidationError) {
      return json({ error: error.message, code: 'invalid_model_identity' }, { status: 400 })
    }
    return json({ error: 'Failed to save model' }, { status: 500 })
  }
}

// DELETE /api/user/saved-models
export const DELETE: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const modelId = url.searchParams.get('id')
  if (!modelId) {
    return json({ error: 'Model ID is required' }, { status: 400 })
  }

  try {
    const agentReferences = await findModelPresetAgentReferences(locals.user.id, modelId)
    if (agentReferences.length > 0) {
      return json(
        {
          error: formatModelPresetReferenceMessage(agentReferences),
          code: 'model_preset_in_use',
          dependencies: {
            agents: agentReferences
          }
        },
        { status: 409 }
      )
    }

    await redis.del(`model:${modelId}`)
    await redis.sRem(`user:${locals.user.id}:models`, modelId)

    return json({ success: true })
  } catch (error) {
    console.error('Failed to delete model:', error)
    return json({ error: 'Failed to delete model' }, { status: 500 })
  }
}
