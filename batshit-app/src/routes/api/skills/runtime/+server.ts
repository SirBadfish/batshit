import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'

import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  executeSkillRuntimeAction,
  type SkillRuntimeAction
} from '$lib/server/services/skillRuntimeToolService'

type SkillRuntimeRequest = {
  userId?: string
  skillId?: string
  action?: SkillRuntimeAction
  path?: string
  maxChars?: number
}

function statusForSkillRuntimeResult(result: { success: boolean; error?: string }) {
  if (result.success) return 200
  if (typeof result.error === 'string' && result.error.includes('was not found')) return 404
  return 400
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as SkillRuntimeRequest | null
    if (!body || typeof body !== 'object') {
      return json(
        {
          success: false,
          error: 'Invalid request body.'
        },
        { status: 400 }
      )
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : ''
    if (!skillId) {
      return json(
        {
          success: false,
          error: 'skillId is required.'
        },
        { status: 400 }
      )
    }

    const result = await executeSkillRuntimeAction({
      userId: auth.userId,
      skillId,
      action: body.action,
      path: typeof body.path === 'string' ? body.path : undefined,
      maxChars: typeof body.maxChars === 'number' ? body.maxChars : undefined
    })

    return json(
      {
        auth: auth.auth,
        userId: auth.userId,
        ...result
      },
      { status: statusForSkillRuntimeResult(result) }
    )
  } catch (error) {
    console.error('[Skills Runtime] failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Skill runtime request failed.'
      },
      { status: 500 }
    )
  }
}
