import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

interface NativeFetchZipRequest {
  userId?: string
  zipId?: string
  includeContent?: boolean
  maxChars?: number
  offset?: number
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as NativeFetchZipRequest | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const zipId = typeof body.zipId === 'string' ? body.zipId.trim() : ''
    if (!zipId) {
      return json({ success: false, error: 'zipId is required.' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }
    return apiFailure('Fetch Zip requires a verified model run.', 403)
  } catch (error) {
    console.error('[Native Tools] fetch-zip failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch zip.'
      },
      { status: 500 }
    )
  }
}
