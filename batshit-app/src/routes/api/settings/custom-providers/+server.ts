import { json } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import {
  deleteCustomProvider,
  listCustomProviders,
  upsertCustomProvider
} from '$lib/server/services/customProviders'
import type { CustomProviderUpsertInput } from '$lib/types/customProviders'
import type { SavedModel } from '$lib/types/savedModels'

async function findCustomProviderModelReferences(userId: string, providerId: string) {
  const modelIds = await redis.sMembers(`user:${userId}:models`)
  if (!modelIds.length) return []

  const models = await Promise.all(
    modelIds.map(async (modelId) => {
      const model = await redis.get(`model:${modelId}`).catch(() => null)
      return model as SavedModel | null
    })
  )

  return models
    .filter((model): model is SavedModel => Boolean(model))
    .filter((model) => {
      const connection = model.connection ?? null
      return (
        connection?.id === providerId ||
        connection?.service === providerId ||
        model.provider === providerId
      )
    })
    .map((model) => ({
      modelId: model.id,
      modelName: model.modelName || model.modelId || model.id
    }))
}

function formatCustomProviderReferenceMessage(
  references: Array<{ modelName: string }>
) {
  const names = references.slice(0, 4).map((reference) => reference.modelName)
  const suffix = references.length > names.length ? ` and ${references.length - names.length} more` : ''
  return `This custom provider is still used by ${names.join(', ')}${suffix}. Choose a different provider for those model presets before deleting it.`
}

export const GET: RequestHandler = async ({ locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const providers = await listCustomProviders(userId)
    return json({ success: true, providers })
  } catch (error) {
    console.error('[Custom Providers] Failed to list providers:', error)
    return json({ success: false, error: 'Failed to load custom providers' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const payload = (await request.json()) as CustomProviderUpsertInput
    const provider = await upsertCustomProvider(userId, payload)
    return json({ success: true, provider })
  } catch (error: any) {
    console.error('[Custom Providers] Failed to save provider:', error)
    return json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save custom provider'
    }, { status: 400 })
  }
}

export const DELETE: RequestHandler = async ({ request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return apiFailure('Unauthorized', 401)
  }

  try {
    const { id } = await request.json()
    if (!id || typeof id !== 'string') {
      return json({ success: false, error: 'Provider id is required' }, { status: 400 })
    }
    const modelReferences = await findCustomProviderModelReferences(userId, id)
    if (modelReferences.length > 0) {
      return json(
        {
          success: false,
          error: formatCustomProviderReferenceMessage(modelReferences),
          code: 'custom_provider_in_use',
          dependencies: {
            models: modelReferences
          }
        },
        { status: 409 }
      )
    }
    await deleteCustomProvider(userId, id)
    return json({ success: true, id })
  } catch (error) {
    console.error('[Custom Providers] Failed to delete provider:', error)
    return json({ success: false, error: 'Failed to delete custom provider' }, { status: 500 })
  }
}
