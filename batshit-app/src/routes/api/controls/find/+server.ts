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
  brokerFamilies?: Array<'fabric' | 'batshit'>
  domain?: 'agent-settings'
}

function toFindOptions(
  body: FindControlsRequest,
  userId: string,
  agentId: string | undefined
): ControlFindOptions {
  return {
    userId,
    // This is a scope hint, not a server-vouched acting identity.
    agentId,
    query: body.query,
    ...(body.domain === 'agent-settings' ? { domain: body.domain } : {}),
    brokerFamilies: body.brokerFamilies,
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

    if (body.brokerFamilies !== undefined && (!Array.isArray(body.brokerFamilies) ||
      body.brokerFamilies.some((family) => family !== 'fabric' && family !== 'batshit'))) {
      return json({ success: false, error: 'Invalid brokerFamilies: expected fabric and/or batshit.' }, { status: 400 })
    }
    if (body.domain !== undefined && body.domain !== 'agent-settings') {
      return json({ success: false, error: 'Invalid domain: expected agent-settings.' }, { status: 400 })
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

    const visibleForAgentId = typeof body.agentId === 'string' ? body.agentId.trim() || undefined : undefined

    if (auth.auth === 'portable-skill') {
      const portableResult = await findControls({
        ...toFindOptions(body, auth.userId, visibleForAgentId),
        allowedControlIds: auth.portableSkillAllowedControlIds,
        actorType: auth.auth,
        ...(auth.portableSkillToken ? { portableSettingsActor: { tokenId: auth.portableSkillToken.id, authorityGeneration: auth.portableSkillToken.authorityGeneration ?? 0 } } : {})
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
      actorType: auth.auth
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
