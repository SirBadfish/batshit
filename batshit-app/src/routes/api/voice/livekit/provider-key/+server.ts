import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'

import { isTrustedInternalRequest } from '$lib/server/services/internalRequestAuth'
import {
  getLiveKitProviderKeyConfig,
  normalizeLiveKitProviderKeyId,
  resolveLiveKitProviderKey
} from '$lib/server/services/liveKitSpeechToSpeechProviders'

type ProviderKeyRequestPayload = {
  userId?: string | null
  providerId?: string | null
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const POST: RequestHandler = async ({ request }) => {
  if (!isTrustedInternalRequest(request)) {
    return apiFailure('Unauthorized', 401)
  }

  const payload = (await request.json().catch(() => null)) as ProviderKeyRequestPayload | null
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ success: false, error: 'Invalid LiveKit provider-key payload' }, { status: 400 })
  }

  const userId = cleanString(payload.userId)
  const providerId = normalizeLiveKitProviderKeyId(payload.providerId)

  if (!userId || !providerId) {
    return json({ success: false, error: 'userId and supported providerId are required' }, { status: 400 })
  }

  const resolved = await resolveLiveKitProviderKey(userId, providerId)
  if (!resolved.apiKey) {
    const config = getLiveKitProviderKeyConfig(providerId)
    return json(
      {
        success: false,
        error: `${config.label} API key is not configured.`,
        setupHint: config.setupHint
      },
      { status: 412 }
    )
  }

  return json(
    {
      success: true,
      providerId,
      source: resolved.source,
      apiKey: resolved.apiKey
    },
    {
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}
