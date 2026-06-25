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

    const vercelModel = await findVercelCatalogEntryById(vercelModelId)

    let info: (ModelInfo & { pricing?: any; contextWindow?: number }) | VercelCatalogEntry | null =
      vercelModel ??
      providerManager.listAvailableModels().find((entry) => entry.id === vercelModelId) ??
      null

    if (!info) {
      return json({ error: 'Model not found in catalog' }, { status: 404 })
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
    const contextWindow =
      enrichment?.contextWindow ??
      ('contextWindow' in info ? (info as any).contextWindow : undefined) ??
      info.features.maxTokens ??
      0
    const maxOutputResolution = resolvePresetMaxOutputTokenResolution({
      maxOutputTokens:
        enrichment?.maxOutputTokens ??
        ('maxOutputTokens' in info ? (info as any).maxOutputTokens : undefined) ??
        undefined,
      contextWindow
    })
    const maxOutputTokens = maxOutputResolution.maxOutputTokens
    const compatibility = determineModelCompatibility(info.provider)
    const fallbackPricing =
      'pricing' in info && info.pricing
        ? info.pricing
        : {
            input: undefined,
            output: undefined,
            cachedInput: undefined
          }

    const response = {
      modelName: info.displayName,
      modelId: info.name,
      provider: info.provider,
      contextWindow,
      pricing: {
        input: enrichment?.pricing?.input ?? fallbackPricing.input ?? 0,
        output: enrichment?.pricing?.output ?? fallbackPricing.output ?? 0,
        cachedInput: enrichment?.pricing?.cachedInput ?? fallbackPricing.cachedInput
      },
      capabilities,
      compatibility,
      isVercelImport: Boolean(vercelModel),
      vercelSourceId: info.id,
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
