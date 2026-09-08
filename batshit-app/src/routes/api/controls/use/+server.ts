import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { useControl, type ControlUseErrorCode } from '$lib/server/services/fabricRegistry'
import {
  getPortableSkillFamilyDefinitions,
  getPortableSkillRequiredFamiliesForControl,
  isPortableSkillControlAllowed,
  recordPortableSkillTokenControlExecution
} from '$lib/server/services/portableSkillTokens'

type UseControlRequest = {
  userId?: string
  agentId?: string
  sessionId?: string
  controlId?: string
  input?: Record<string, any>
  dryRun?: boolean
  allowRisky?: boolean
  selectedGateways?: string[]
  allowedControlIds?: string[]
}

const portableFamilyLabels = new Map(
  getPortableSkillFamilyDefinitions().map((family) => [family.id, family.label])
)

function statusForControlError(code?: ControlUseErrorCode): number {
  switch (code) {
    case 'CONTROL_NOT_FOUND':
      return 404
    case 'CONTROL_NOT_ALLOWED':
    case 'CONTROL_RISK_REQUIRES_APPROVAL':
    // A woken turn's risky-control refusal is a POLICY answer, not a server fault. It fell
    // through to `default: 500` — a retryable status — for a refusal that must never be
    // retried, which is the loop `human_turn_hint` exists to stop.
    case 'CONTROL_RISK_NEEDS_HUMAN_TURN':
      return 403
    case 'CONTROL_INPUT_INVALID':
      return 400
    case 'CONTROL_NOT_EXECUTABLE':
      return 409
    case 'CONTROL_EXECUTION_FAILED':
      return 500
    default:
      return 500
  }
}

function portableScopeErrorMessage(controlId: string, grantedFamilies: string[]): string {
  const required = getPortableSkillRequiredFamiliesForControl(controlId)
  if (required.length === 0) {
    return `Control "${controlId}" is not available through Portable Skills.`
  }

  const requiredLabels = required.map((family) => portableFamilyLabels.get(family) ?? family)
  const grantedLabels = grantedFamilies.map((family) => portableFamilyLabels.get(family as any) ?? family)
  return `Control "${controlId}" requires Portable Skill Token scope: ${requiredLabels.join(' or ')}. This token currently grants: ${grantedLabels.length > 0 ? grantedLabels.join(', ') : 'none'}.`
}

async function recordPortableAttempt(options: {
  auth: Awaited<ReturnType<typeof resolveNativeToolUser>>
  controlId: string
  success: boolean
  errorCode?: string | null
}) {
  if (options.auth?.auth !== 'portable-skill' || !options.auth.portableSkillToken) return
  try {
    await recordPortableSkillTokenControlExecution({
      userId: options.auth.userId,
      tokenId: options.auth.portableSkillToken.id,
      tokenLabel: options.auth.portableSkillToken.label,
      controlId: options.controlId,
      success: options.success,
      errorCode: options.errorCode
    })
  } catch (error) {
    console.warn('[Controls Use] failed to record portable token execution:', error)
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as UseControlRequest | null
    if (!body || typeof body !== 'object') {
      return json(
        {
          success: false,
          error: {
            code: 'CONTROL_INPUT_INVALID',
            message: 'Invalid request body.'
          }
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
      return json(
        {
          success: false,
          error: {
            code: 'CONTROL_NOT_ALLOWED',
            message: 'Unauthorized'
          }
        },
        { status: 401 }
      )
    }

    const controlId = typeof body.controlId === 'string' ? body.controlId.trim() : ''
    if (!controlId) {
      return json(
        {
          success: false,
          error: {
            code: 'CONTROL_INPUT_INVALID',
            message: 'controlId is required.'
          }
        },
        { status: 400 }
      )
    }

    if (
      auth.auth === 'portable-skill' &&
      !isPortableSkillControlAllowed(controlId, auth.portableSkillToken?.families ?? [])
    ) {
      await recordPortableAttempt({
        auth,
        controlId,
        success: false,
        errorCode: 'CONTROL_NOT_ALLOWED'
      })
      return json(
        {
          auth: auth.auth,
          userId: auth.userId,
          success: false,
          controlId,
          error: {
            code: 'CONTROL_NOT_ALLOWED',
            message: portableScopeErrorMessage(controlId, auth.portableSkillToken?.families ?? [])
          }
        },
        { status: 403 }
      )
    }

    // `sessionId` is body text, and the woken-turn gate and the risk-approval cache both
    // read it. A session this user does not own must not be able to speak for them, so an
    // unowned id is dropped rather than trusted — the gate then falls back to the wake
    // registry, which is server-owned, instead of to a chat somebody else is sitting in.
    const claimedSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    let sessionId: string | undefined
    if (claimedSessionId) {
      const session = await redis.getSession(claimedSessionId)
      if (session && session.user_id === auth.userId) sessionId = claimedSessionId
    }

    const result = await useControl({
      userId: auth.userId,
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
      sessionId,
      controlId,
      input: body.input && typeof body.input === 'object' ? body.input : {},
      dryRun: body.dryRun === true,
      allowRisky: auth.auth === 'portable-skill' ? true : body.allowRisky === true,
      actorType: auth.auth,
      selectedGateways: Array.isArray(body.selectedGateways) ? body.selectedGateways : undefined,
      allowedControlIds:
        auth.auth === 'portable-skill'
          ? auth.portableSkillAllowedControlIds
          : Array.isArray(body.allowedControlIds)
            ? body.allowedControlIds
            : undefined
    })

    await recordPortableAttempt({
      auth,
      controlId: result.controlId ?? controlId,
      success: result.success,
      errorCode: result.success ? null : result.error.code
    })

    if (!result.success) {
      return json(
        {
          auth: auth.auth,
          userId: auth.userId,
          ...result
        },
        { status: statusForControlError(result.error.code) }
      )
    }

    return json({
      auth: auth.auth,
      userId: auth.userId,
      ...result
    })
  } catch (error) {
    console.error('[Controls Use] failed:', error)
    return json(
      {
        success: false,
        error: {
          code: 'CONTROL_EXECUTION_FAILED',
          message: error instanceof Error ? error.message : 'Controls execution failed.'
        }
      },
      { status: 500 }
    )
  }
}
