import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import {
  findControls,
  type ControlFindOptions,
  type ControlRuntimeMode,
  type ControlRiskLevel,
  type ControlSourceType
} from '$lib/server/services/fabricRegistry'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

type FindControlsRequest = {
  userId?: string
  agentId?: string
  query?: string
  tags?: string[]
  sourceType?: ControlSourceType | ControlSourceType[]
  riskLevel?: ControlRiskLevel | ControlRiskLevel[]
  runtimeMode?: ControlRuntimeMode
  includeSchema?: boolean
  includeDraft?: boolean
  limit?: number
  allowedControlIds?: string[]
}

function toFindOptions(body: FindControlsRequest, userId: string): ControlFindOptions {
  return {
    userId,
    agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
    query: body.query,
    tags: Array.isArray(body.tags) ? body.tags : [],
    sourceType: body.sourceType,
    riskLevel: body.riskLevel,
    runtimeMode: body.runtimeMode,
    includeSchema: body.includeSchema === true,
    includeDraft: body.includeDraft === true,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
    allowedControlIds: Array.isArray(body.allowedControlIds) ? body.allowedControlIds : undefined
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as FindControlsRequest | null
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

    if (auth.auth === 'portable-skill') {
      const portableResult = await findControls({
        ...toFindOptions(body, auth.userId),
        allowedControlIds: auth.portableSkillAllowedControlIds
      })
      return json({
        success: true,
        auth: auth.auth,
        userId: auth.userId,
        ...portableResult
      })
    }

    const result = await findControls(toFindOptions(body, auth.userId))
    return json({
      success: true,
      auth: auth.auth,
      userId: auth.userId,
      ...result
    })
  } catch (error) {
    console.error('[Controls Find] failed:', error)
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Controls find failed.'
      },
      { status: 500 }
    )
  }
}
