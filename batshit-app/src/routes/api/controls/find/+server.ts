import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'
import {
  findControls,
  type ControlFindOptions,
  type ControlRuntimeMode,
  type ControlRiskLevel,
  type ControlSourceType
} from '$lib/server/services/fabricRegistry'
import {
  PORTABLE_SKILL_SCOPED_DISCOVERY,
  resolveNativeToolUser
} from '$lib/server/services/nativeToolAuth'
import {
  bindActingAgentId,
  boundDelegatedAllowedControlIds,
  boundScopeAgentId
} from '$lib/server/services/actingAgentIdentity'

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

function toFindOptions(
  body: FindControlsRequest,
  userId: string,
  agentId: string | undefined
): ControlFindOptions {
  return {
    userId,
    // SA-117 DL-117-04: bound off the run credential on the agent lane, the caller's claim
    // everywhere else. Here it only narrows which controls are VISIBLE, but a scope hint the
    // server minted is still better than one the body typed.
    agentId,
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
      claimedUserId: body.userId ?? null,
      // BL-704: one of the two routes that admit a Portable Skill Token. Discovery shows only
      // the token's family controls (`allowedControlIds` below comes off the token, never the body).
      portableSkillPolicy: PORTABLE_SKILL_SCOPED_DISCOVERY
    })

    if (!auth) {
      return apiFailure('Unauthorized', 401)
    }

    const agentBinding = bindActingAgentId(auth, body.agentId)
    if (!agentBinding.ok) {
      return json(
        { success: false, error: { code: agentBinding.code, message: agentBinding.message } },
        { status: 400 }
      )
    }

    // BL-81: a Subagent or Worker run is shown exactly what `/api/controls/use` will run for it:
    // only the controls its credential carries (the ones its DCM offered it; none for a
    // credential minted before BL-81), with agent allowlists judged by its scope id, the id
    // that route judges them by. `boundScopeAgentId` and `boundDelegatedAllowedControlIds` have
    // the reasons; both are empty on every other call, which keeps its existing answer.
    const visibleForAgentId = boundScopeAgentId(auth) || agentBinding.agentId
    const delegatedAllowedControlIds = boundDelegatedAllowedControlIds(auth)

    if (auth.auth === 'portable-skill') {
      const portableResult = await findControls({
        ...toFindOptions(body, auth.userId, visibleForAgentId),
        allowedControlIds: auth.portableSkillAllowedControlIds
      })
      return json({
        success: true,
        auth: auth.auth,
        userId: auth.userId,
        ...portableResult
      })
    }

    const result = await findControls({
      ...toFindOptions(body, auth.userId, visibleForAgentId),
      ...(delegatedAllowedControlIds ? { delegatedRun: true, delegatedAllowedControlIds } : {})
    })
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
