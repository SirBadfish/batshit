import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { ProviderManager, type ModelInfo } from '$lib/server/services/providers'
import {
  providerFeaturesToCapabilities,
  mergeCapabilities
} from '$lib/server/services/modelManagerHelpers'
import { determineModelCompatibility } from '$lib/data/model-compatibility-registry'
import { getArtificialAnalysisEnrichment } from '$lib/server/services/artificialAnalysisService'
import {
  findVercelCatalogEntryById,
  type VercelCatalogEntry
} from '$lib/server/services/vercelModelCatalog'
import { resolvePresetMaxOutputTokenResolution } from '$lib/utils/modelOutputTokens'
import { resolveCatalogIds } from '$lib/utils/modelIdResolver'
import { resolveConnectionServiceFromId } from '$lib/utils/modelConnections'
import {
  resolveCatalogConnectionLimits,
  resolveCatalogConnectionPricing
} from '$lib/utils/catalogConnectionLimits'

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const providerManager = await ProviderManager.createForUser(locals.user.id)
    const body = await request.json()

    const vercelModelId: string | null =
      body.vercelModelId ||
      (body.provider && body.modelId ? `${body.provider}/${body.modelId}` : null)

    if (!vercelModelId) {
      return json(
        { error: 'vercelModelId or provider/modelId is required' },
        { status: 400 }
      )
    }

    const requestedConnectionId = typeof body.connectionId === 'string' ? body.connectionId.trim() : ''
    const vercelModel = await findVercelCatalogEntryById(vercelModelId, requestedConnectionId || null)
    const selectedConnectionId = String(
      requestedConnectionId || vercelModel?.connectionId || ''
    ).trim()

    let info: (ModelInfo & { pricing?: any; contextWindow?: number }) | VercelCatalogEntry | null =
      vercelModel ??
      providerManager.listAvailableModels().find((entry) => entry.id === vercelModelId) ??
      null

    if (!info) {
      return json({ error: 'Model not found in catalog' }, { status: 404 })
    }

    const selectedTransport =
      selectedConnectionId === 'vercel-gateway'
        ? 'vercel-gateway'
        : selectedConnectionId === 'openrouter'
          ? 'openrouter'
          : 'direct'
    const selectedService =
      selectedConnectionId === 'vercel-gateway'
        ? 'vercel'
        : selectedConnectionId === 'openrouter'
          ? 'openrouter'
          : resolveConnectionServiceFromId(selectedConnectionId)
    const catalogIdentity = vercelModel
      ? resolveCatalogIds({
          connectionId: selectedConnectionId,
          connection: selectedConnectionId
            ? {
                id: selectedConnectionId,
                transport: selectedTransport,
                service: selectedService,
                providers: selectedService ? [selectedService] : undefined
              }
            : null,
          developerId: vercelModel.provider,
          modelId: vercelModel.name,
          idVariants: vercelModel.idVariants ?? null
        })
      : null

    if (vercelModel && selectedConnectionId && !catalogIdentity?.source) {
      return json(
        {
          error: `The Model Catalog does not have an exact provider identifier for ${selectedConnectionId}. Refresh the catalog before applying this model.`,
          code: 'invalid_model_identity'
        },
        { status: 409 }
      )
    }

    let enrichment = null
    let warning: string | undefined

    try {
      enrichment = await getArtificialAnalysisEnrichment({
        provider: info.provider,
        modelId: info.name,
        modelName: info.displayName,
        vercelModelId,
        forceRefresh: body.forceRefresh === true
      })
    } catch {
      enrichment = null
    }

    const providerCapabilities = providerFeaturesToCapabilities(info.features)
    const capabilities = mergeCapabilities(providerCapabilities, enrichment?.capabilities)
    // BL-68: a connection that joined a merged row through a reviewed identity
    // rule has its own limits; neither the row's numbers (from another
    // connection) nor Artificial Analysis's model-wide ones stand in for them.
    const connectionLimits = vercelModel
      ? resolveCatalogConnectionLimits(vercelModel, selectedConnectionId)
      : null
    // BL-67: blank sends nothing. A row with no known window returns none, never 0.
    const contextWindow = connectionLimits?.perConnection
      ? connectionLimits.contextWindow
      : toPositiveNumber(
          enrichment?.contextWindow ??
            ('contextWindow' in info ? (info as any).contextWindow : undefined) ??
            info.features.maxTokens
        )
    const maxOutputResolution = resolvePresetMaxOutputTokenResolution({
      maxOutputTokens: connectionLimits?.perConnection
        ? connectionLimits.maxOutputTokens
        : enrichment?.maxOutputTokens ??
          ('maxOutputTokens' in info ? (info as any).maxOutputTokens : undefined) ??
          undefined,
      contextWindow
    })
    const maxOutputTokens = maxOutputResolution.maxOutputTokens
    const compatibility = determineModelCompatibility(info.provider)
    // BL-132: a connection whose own source lists a different price than the
    // merged row (DeepInfra, Together) carries it on its variant; neither the
    // row's price (another connection's) nor Artificial Analysis stands in for it.
    const connectionPricing = vercelModel
      ? resolveCatalogConnectionPricing(vercelModel, selectedConnectionId)
      : null
    const fallbackPricing =
      'pricing' in info && info.pricing
        ? info.pricing
        : {
            input: undefined,
            output: undefined,
            cachedInput: undefined
          }
    // Decision A (2026-09-25): a price the catalog lists wins; Artificial
    // Analysis fills only a row that lists none.
    const catalogListsPrice = [fallbackPricing.input, fallbackPricing.output, fallbackPricing.cachedInput].some(
      (value) => value !== undefined && value !== null
    )

    const pricing = connectionPricing?.perConnection
      ? {
          input: connectionPricing.pricing?.input,
          output: connectionPricing.pricing?.output,
          cachedInput: connectionPricing.pricing?.cachedInput
        }
      : catalogListsPrice
        ? {
            input: fallbackPricing.input,
            output: fallbackPricing.output,
            cachedInput: fallbackPricing.cachedInput
          }
        : {
            input: enrichment?.pricing?.input,
            output: enrichment?.pricing?.output,
            cachedInput: enrichment?.pricing?.cachedInput
          }

    const response = {
      modelName: info.displayName,
      modelId: catalogIdentity?.modelId ?? info.name,
      provider: catalogIdentity?.developerId ?? info.provider,
      catalogModelId: vercelModel?.id,
      effectiveModelId: catalogIdentity?.effectiveModelId,
      contextWindow,
      // BL-67: an unknown price stays absent (the Token Panel then says Unknown); a
      // catalog price of 0 is a real zero and passes through.
      pricing,
      capabilities,
      compatibility,
      isVercelImport: Boolean(vercelModel && selectedConnectionId === 'vercel-gateway'),
      vercelSourceId:
        vercelModel && selectedConnectionId === 'vercel-gateway' ? vercelModel.id : undefined,
      vercelDisplayName: info.displayName,
      settings: {
        maxTokens: maxOutputTokens
      },
      enrichment: {
        ...(enrichment ?? {
          source: vercelModel ? 'vercel-catalog' : 'provider-manager',
          fetchedAt: new Date().toISOString(),
          contextWindow,
          capabilities: providerCapabilities
        }),
        // BL-68: the saved baseline records the window this connection really has.
        ...(connectionLimits?.perConnection ? { contextWindow } : {}),
        // BL-132 / decision A: and the price this connection really charges, so
        // Restore Defaults never brings back an Artificial Analysis price.
        ...(connectionPricing?.perConnection || (enrichment?.pricing && catalogListsPrice) ? { pricing } : {}),
        maxOutputTokens,
        maxOutputTokensEstimated: maxOutputResolution.estimated,
        maxOutputTokensEstimateReason:
          maxOutputResolution.reason === 'provided' ? undefined : maxOutputResolution.reason
      }
    }

    return json({
      data: response,
      success: true,
      warning
    })
  } catch (error) {
    console.error('[Model Enrich] Failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to enrich model' },
      { status: 500 }
    )
  }
}
