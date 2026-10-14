import { pausedPlanAddRefusal } from '$lib/server/services/pausedPlans'
import { normaliseChatgptPlanPreset } from '$lib/server/services/chatgptPlanPreset'
import { withChatgptPlanPublishedMetadata } from '$lib/data/chatgpt-plan-published-metadata'
import { chatgptPlanAccounts } from '$lib/server/services/chatgptPlanHost'
import { ChatgptPlanError } from '$lib/server/services/chatgptPlanVault'
import { chatgptPlanAccountId, isChatgptPlanConnection } from '$lib/utils/chatgptPlanConnection'
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { type SavedModel, type PricingTier, isTieredPricing, type ModelConnectionInfo, type ImageTransport, type ModelPurpose } from '$lib/types/savedModels'
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
import {
  GATEWAY_UNLISTED_PRESET_REASON,
  buildSavedModelCatalogLookup,
  gatewayListsCatalogRow,
  isGatewayCatalogPreset,
  resolveCatalogConnectionId
} from '$lib/server/services/savedModelCatalogMatch'
import {
  findModelPresetReferences,
  formatModelPresetReferenceMessage
} from '$lib/server/services/modelPresetReferences'

class ModelPresetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelPresetValidationError'
  }
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

function resolveCatalogPresetIdentity(
  catalogEntry: Awaited<ReturnType<typeof findVercelCatalogEntryById>>,
  connection: ModelConnectionInfo
) {
  if (!catalogEntry) return null
  const connectionId = resolveCatalogConnectionId(connection)
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

function toPositiveNumber(value: unknown): number | undefined {
  const parsed = toNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function isLocalAiConnection(connection: ModelConnectionInfo): boolean {
  return (
    connection.type === 'direct' &&
    (LOCAL_AI_SERVER_IDS as ReadonlySet<string>).has(connection.service ?? '')
  )
}

/** The managed Codex CLI and Claude Code CLI connections, which the user's plan pays for. */
const SUBSCRIPTION_CLI_SERVICES: ReadonlySet<string> = new Set(['openai-codex', 'anthropic-claude-cli'])

function isSubscriptionCliConnection(connection: ModelConnectionInfo): boolean {
  return SUBSCRIPTION_CLI_SERVICES.has(connection.service ?? '')
}

/**
 * BL-67: blank sends nothing, zero is real. A price the payload does not carry stays
 * ABSENT so the Token Panel says Unknown instead of an exact $0.00. The derived zeros
 * are the presets whose per-token price really is nothing: a Local AI program on the
 * user's own machine, and a Codex CLI or Claude Code CLI run that the user's plan covers.
 */
function normalizePresetPricing(
  raw: Partial<SavedModel['pricing']> | null | undefined,
  realZeroPrice: boolean
): SavedModel['pricing'] {
  const pricing: SavedModel['pricing'] = {}
  const readPrice = (value: unknown) =>
    isTieredPricing(value as SavedModel['pricing']['input'])
      ? (value as PricingTier[]).length > 0
        ? (value as PricingTier[])
        : undefined
      : toNumber(value)
  const input = readPrice(raw?.input)
  const output = readPrice(raw?.output)
  const cachedInput = toNumber(raw?.cachedInput)
  if (input !== undefined) pricing.input = input
  if (output !== undefined) pricing.output = output
  if (cachedInput !== undefined) pricing.cachedInput = cachedInput
  if (realZeroPrice) {
    pricing.input ??= 0
    pricing.output ??= 0
    pricing.cachedInput ??= 0
  }
  return pricing
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
    ? await findVercelCatalogEntryById(requestedCatalogModelId, resolveCatalogConnectionId(resolvedConnection))
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
    contextWindow: toPositiveNumber(payload.contextWindow),
    pricing: normalizePresetPricing(
      payload.pricing,
      isLocalAiConnection(resolvedConnection) || isSubscriptionCliConnection(resolvedConnection)
    ),
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
  // BL-517: the list answer's availability mark is worked out on each load, never stored.
  delete model.unavailableReason

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

  // BL-67: an unknown context window is ABSENT, never 0 (blank sends nothing).
  if (model.contextWindow === undefined) delete model.contextWindow

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

/**
 * The user's saved presets, newest first. BL-517: a read never deletes. A preset whose model a
 * connection stopped listing stays stored (with its settings, and for the agents that name it);
 * the GET marks it unavailable in its answer instead.
 */
async function loadUserModels(userId: string): Promise<SavedModel[]> {
  const modelIds = await redis.sMembers(`user:${userId}:models`)
  const models: SavedModel[] = []
  for (const modelId of modelIds) {
    const record = (await redis.get(`model:${modelId}`)) as SavedModel | null
    if (record) {
      models.push(record)
    }
  }

  models.sort(
    (a, b) =>
      new Date(b.createdAt || b.updatedAt || 0).getTime() -
      new Date(a.createdAt || a.updatedAt || 0).getTime()
  )

  return models
}

function repairSavedModelIdentity(
  model: SavedModel,
  catalogEntry: Awaited<ReturnType<typeof findVercelCatalogEntryById>>
) {
  const connection = resolveSavedModelConnection(model)
  let changed = false

  const connectionId = resolveCatalogConnectionId(connection)
  const hasCatalogVariant = Boolean(
    connectionId && catalogEntry?.idVariants?.[connectionId]
  )
  if (catalogEntry && hasCatalogVariant) {
    const identity = resolveCatalogPresetIdentity(catalogEntry, connection)
    if (identity) {
      // The saved baseline (what Restore Defaults returns to, and what the editor
      // compares against to say "provider modified") recorded the old identity.
      // A field it recorded as the old value moves with the repair in the same
      // write; a field it recorded as something else is left alone (review
      // finding 2: the MiMo Token Plan's `mimo` became `xiaomi` in BL-241).
      const baseline = model.enrichment
      const moveBaseline = (field: 'provider' | 'modelId' | 'identifier', from: string | undefined, to: string) => {
        if (baseline && from !== undefined && baseline[field] === from) baseline[field] = to
      }
      if (model.catalogModelId !== catalogEntry.id) {
        model.catalogModelId = catalogEntry.id
        changed = true
      }
      if (model.provider !== identity.developerId) {
        moveBaseline('provider', model.provider, identity.developerId)
        model.provider = identity.developerId
        changed = true
      }
      if (model.modelId !== identity.modelId) {
        moveBaseline('modelId', model.modelId, identity.modelId)
        model.modelId = identity.modelId
        changed = true
      }
      if (model.effectiveModelId !== identity.effectiveModelId) {
        moveBaseline('identifier', model.effectiveModelId, identity.effectiveModelId)
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
    const models = await loadUserModels(locals.user.id)
    // BL-68: a preset saved on a row that later merged into or was renamed to another still
    // finds its model through its own connection's variant id.
    const findCatalogRow = buildSavedModelCatalogLookup(catalog.models)

    let purposeBackfilledCount = 0
    let identityBackfilledCount = 0
    const unlisted: { id: string; modelName: string }[] = []
    const answered: SavedModel[] = []
    for (const model of models) {
      if (isChatgptPlanConnection(model.connection?.id) || model.connection?.service === 'chatgpt-plan') {
        const ready = chatgptPlanAccounts(locals.user.id).some(account => account.id === chatgptPlanAccountId(model.connection?.id) && account.state === 'ready')
        const projected = withChatgptPlanPublishedMetadata(model)
        answered.push(ready ? projected : { ...projected, unavailableReason: 'Reconnect this ChatGPT account in Settings → API Keys on this Mac.' })
        continue
      }
      const match = findCatalogRow(model)
      const identityChanged = repairSavedModelIdentity(model, match)
      if (identityChanged) {
        identityBackfilledCount += 1
      }
      const purposeChanged = repairSavedModelPurpose(model, match)
      if (purposeChanged) {
        purposeBackfilledCount += 1
      }
      // Written only while the preset still exists: a preset deleted since this load read it is
      // not made again as a key no list names (review of BL-517), and it leaves the answer.
      if ((identityChanged || purposeChanged) && !(await redis.json.setIfExists(`model:${model.id}`, '$', model))) {
        continue
      }
      // BL-517: a gateway preset the gateway no longer lists stays; the answer (never the stored
      // preset) says so, and the pickers show it as unavailable. The send says the same.
      if (isGatewayCatalogPreset(model) && !gatewayListsCatalogRow(match)) {
        unlisted.push({ id: model.id, modelName: model.modelName })
        answered.push({ ...model, unavailableReason: GATEWAY_UNLISTED_PRESET_REASON })
      } else {
        answered.push(model)
      }
    }

    return json({
      models: answered,
      meta: {
        unlisted,
        purposeBackfilledCount,
        identityBackfilledCount,
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
  repairSavedModelPurpose as _repairSavedModelPurpose
}

// POST /api/user/saved-models
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = (await request.json()) as SavedModel
    // Plan pause: a model of a paused plan cannot be added or saved.
    const paused = await pausedPlanAddRefusal(
      payload?.connection?.service ?? payload?.connection?.id ?? null
    )
    if (paused) {
      return json({ error: paused.message, code: 'paused_plan' }, { status: 409 })
    }
    // BL-516: a create sends no id (the id is built from the name, model, and connection); an
    // update names its id. A create never replaces a saved preset, and an update never makes one.
    const isUpdate = typeof payload?.id === 'string' && payload.id.trim().length > 0
    const model = isChatgptPlanConnection(payload.connection?.id) || payload.connection?.service === 'chatgpt-plan'
      ? await normaliseChatgptPlanPreset(payload, locals.user.id)
      : await normaliseSavedModel(payload, await ProviderManager.createForUser(locals.user.id))

    const now = new Date().toISOString()
    model.createdAt = model.createdAt || now
    model.updatedAt = now

    const setKey = `user:${locals.user.id}:models`
    const modelKey = `model:${model.id}`
    const missing = json(
      {
        error: 'This model preset no longer exists. It may have been deleted in another window; reload Settings → Models.',
        code: 'model_preset_missing'
      },
      { status: 404 }
    )

    if (isUpdate) {
      if (!(await redis.sismember(setKey, model.id))) {
        return missing
      }
      // Written only while the preset is still there, so a delete that lands first wins.
      if (!(await redis.json.setIfExists(modelKey, '$', model))) {
        return missing
      }
    } else {
      // Made in one step only while no preset has that id (`JSON.SET … NX`), so two creates of
      // one id at the same moment cannot both write.
      if (!(await redis.json.setIfAbsent(modelKey, '$', model))) {
        const existing = (await redis.get(modelKey)) as SavedModel | null
        const isOwned = await redis.sismember(setKey, model.id)
        const existingName = isOwned && existing?.modelName?.trim() ? `: "${existing.modelName.trim()}"` : ''
        return json(
          {
            error: `A model preset with that name already exists${existingName}. Choose a different display name.`,
            code: 'model_preset_exists'
          },
          { status: 409 }
        )
      }
      await redis.sAdd(setKey, model.id)
    }

    return json({ success: true, model })
  } catch (error) {
    if (error instanceof ChatgptPlanError) return json({ error: error.message, code: error.code }, { status: 409 })
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
    // BL-483: every place a preset id is stored, each named in the refusal.
    const references = await findModelPresetReferences(locals.user.id, modelId)
    if (references.length > 0) {
      return json(
        {
          error: formatModelPresetReferenceMessage(references),
          code: 'model_preset_in_use',
          dependencies: { references }
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
