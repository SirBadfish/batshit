import { json, type RequestHandler } from '@sveltejs/kit'
import { toolTextBudgetHeaders } from '$lib/server/services/toolTextBudget'
import { apiFailure } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { refuseDelegatedRunOutsideList } from '$lib/server/services/actingAgentIdentity'
import { nativeToolService } from '$lib/server/services/nativeTools'

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
    if (auth.auth !== 'agent') {
      return apiFailure('Fetch Zip requires a verified model run.', 403)
    }
    if (auth.fetchZipAllowed !== true) {
      return apiFailure('Fetch Zip was not enabled for this run.', 403, {
        code: 'FETCH_ZIP_UNAVAILABLE'
      })
    }

    // BL-81 follow-up: a Subagent or Worker run's credential fetches a zip here only when its
    // list allows `sys.zip.fetch`, the control that does this same work.
    const delegatedRefusal = refuseDelegatedRunOutsideList(auth, 'sys.zip.fetch')
    if (delegatedRefusal) {
      return apiFailure(delegatedRefusal.message, 403, { code: delegatedRefusal.code })
    }

    const result = await nativeToolService.nativeFetchZip({
      userId: auth.userId,
      agentId: auth.agentId,
      sessionId: auth.sessionId,
      messageId: auth.messageId,
      actorType: auth.auth,
      zipId,
      includeContent: body.includeContent,
      maxChars: body.maxChars,
      offset: body.offset
    })

    if (result.code === 'INVALID_OFFSET' || result.code === 'INVALID_MAX_CHARS' ||
      result.code === 'OFFSET_PAST_END') {
      return apiFailure(result.reason, 400, { code: result.code })
    }
    if (result.code === 'MODEL_SCOPE_REQUIRED') {
      return apiFailure(result.reason, 403, { code: result.code })
    }

    return json({
      success: true,
      auth: auth.auth,
      ...result
    }, { headers: { ...toolTextBudgetHeaders(auth), 'x-batshit-tool-page-kind': 'fetch-zip' } })
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
