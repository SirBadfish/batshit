import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService } from '$lib/server/services/nativeTools'

interface NativeWebSearchRequest {
  userId?: string
  query?: string
  provider?: 'duckduckgo-html' | 'exa' | 'perplexity'
  exaSearchType?: 'auto' | 'fast' | 'neural' | 'deep'
  perplexityMaxTokensPerPage?: number
  maxResults?: number
  region?: string
  safeSearch?: 'strict' | 'moderate' | 'off'
  timeoutMs?: number
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as NativeWebSearchRequest | null
    if (!body || typeof body !== 'object') {
      return json({ success: false, error: 'Invalid request body.' }, { status: 400 })
    }

    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) {
      return json({ success: false, error: 'query is required.' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    const result = await nativeToolService.nativeWebSearch({
      userId: auth.userId,
      query,
      provider: body.provider,
      exaSearchType: body.exaSearchType,
      perplexityMaxTokensPerPage: body.perplexityMaxTokensPerPage,
      maxResults: body.maxResults,
      region: body.region,
      safeSearch: body.safeSearch,
      timeoutMs: body.timeoutMs
    })

    const statusCode = result.success === false ? 400 : 200
    return json(
      {
        auth: auth.auth,
        ...result
      },
      { status: statusCode }
    )
  } catch (error) {
    console.error('[Native Tools] web-search failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Web search failed.'
      },
      { status: 500 }
    )
  }
}
