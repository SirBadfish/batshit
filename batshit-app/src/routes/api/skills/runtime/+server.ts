import { json, type RequestHandler } from '@sveltejs/kit'
import { apiFailure } from '$lib/server/services/apiResponses'

import { redis } from '$lib/server/redis'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { isSkillAccessRefusalCode } from '$lib/server/services/slashCommandCapabilities'
import {
  executeSkillRuntimeAction,
  type SkillRuntimeAction,
  type SkillRuntimeActor
} from '$lib/server/services/skillRuntimeToolService'

type SkillRuntimeRequest = {
  userId?: string
  skillId?: string
  /** Signed-in (`session`) calls only: the agent or subagent whose skill access applies. */
  agentId?: string
  action?: SkillRuntimeAction
  path?: string
  maxChars?: number
}

type ResolvedAuth = NonNullable<Awaited<ReturnType<typeof resolveNativeToolUser>>>

function statusForSkillRuntimeResult(result: { success: boolean; error?: string; errorCode?: unknown }) {
  if (result.success) return 200
  // BL-75: an access refusal is a permission answer, not a bad request.
  if (isSkillAccessRefusalCode(result.errorCode)) return 403
  if (typeof result.error === 'string' && result.error.includes('was not found')) return 404
  return 400
}

/**
 * BL-75 — whose skill access applies to this call, by the lane it authenticated on.
 *
 * - `agent`: the run credential. A primary run is its own agent. A delegated run is the
 *   Subagent or Worker its credential names; one minted before BL-75 names none, and loads none.
 * - `session`: the signed-in user may act for any of their own agents, so the body names one,
 *   and it must be theirs.
 * - `service`, `portable-skill`, `n8n-callback`: no agent identity here, so no skill loads.
 *   An n8n Workflow Subagent loads skills through `/api/native-tools/dispatch` instead.
 */
async function resolveSkillRuntimeActor(
  auth: ResolvedAuth,
  claimedAgentId: unknown
): Promise<{ ok: true; actor: SkillRuntimeActor } | { ok: false; status: number; error: string }> {
  if (auth.auth === 'agent') {
    if (auth.delegated === true) {
      return auth.scopeAgentId
        ? { ok: true, actor: { kind: 'agent', agentId: auth.scopeAgentId, delegated: true } }
        : { ok: true, actor: { kind: 'none', lane: 'agent-unscoped-delegated' } }
    }
    const agentId = auth.agentId?.trim() || ''
    return agentId
      ? { ok: true, actor: { kind: 'agent', agentId } }
      : { ok: true, actor: { kind: 'none', lane: 'agent' } }
  }

  if (auth.auth === 'session') {
    const agentId = typeof claimedAgentId === 'string' ? claimedAgentId.trim() : ''
    if (!agentId) {
      return { ok: false, status: 400, error: 'agentId is required: name the agent whose skills to load.' }
    }
    const agent = (await redis.get(`agent:${agentId}`)) as { user_id?: string } | null
    if (agent && agent.user_id === auth.userId) {
      return { ok: true, actor: { kind: 'agent', agentId } }
    }
    const subagent = (await redis.get(`subagent:${agentId}`)) as { user_id?: string } | null
    if (subagent && subagent.user_id === auth.userId) {
      return { ok: true, actor: { kind: 'agent', agentId, delegated: true } }
    }
    return { ok: false, status: 400, error: `Agent "${agentId}" was not found for this user.` }
  }

  return { ok: true, actor: { kind: 'none', lane: auth.auth } }
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

    const actor = await resolveSkillRuntimeActor(auth, body.agentId)
    if (!actor.ok) {
      return json({ success: false, error: actor.error }, { status: actor.status })
    }

    const result = await executeSkillRuntimeAction({
      userId: auth.userId,
      skillId,
      actor: actor.actor,
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
