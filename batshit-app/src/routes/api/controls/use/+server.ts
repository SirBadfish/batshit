import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveApprovalCardTarget } from '$lib/server/services/controlApprovals'
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
  /**
   * SA-116 DL-116-07 — the assistant message this call belongs to.
   *
   * The managed CLI helper sends it from `BATSHIT_MESSAGE_ID`. Verified against the owned
   * session below, so a caller cannot pin a card onto somebody else's chat.
   */
  messageId?: string
  controlId?: string
  input?: Record<string, any>
  dryRun?: boolean
  /**
   * SA-116 DL-116-01 — **ignored on every lane except `portable-skill`.**
   *
   * Still accepted so a stale caller (an old MCP proxy schema, an n8n workflow) gets the
   * approval card rather than a 400 it cannot act on.
   */
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
    // A pause and a group refusal are POLICY answers, not server faults. Falling through to
    // `default: 500` — a retryable status — would tell the caller to try again, which is
    // exactly the loop the guidance exists to stop. SA-113 shipped this for the woken
    // refusal; SA-116 retires that code and keeps the rule for its two replacements.
    case 'CONTROL_RISK_REQUIRES_APPROVAL':
    case 'CONTROL_RISK_UNAVAILABLE_IN_GROUP':
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

    // `sessionId` and `messageId` are body text — the woken-turn gate reads the first and
    // the approval card is pinned to the second. `resolveApprovalCardTarget` owns both
    // ownership checks for this route and `/api/cli-tools/execute` alike, because the same
    // rule written twice is how DL-116-14's hole came to exist in two files.
    const { sessionId, messageId } = await resolveApprovalCardTarget({
      userId: auth.userId,
      sessionId: body.sessionId,
      messageId: body.messageId
    })

    const result = await useControl({
      userId: auth.userId,
      agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
      sessionId,
      messageId,
      controlId,
      input: body.input && typeof body.input === 'object' ? body.input : {},
      dryRun: body.dryRun === true,
      // DL-116-01/DL-116-09: the flag survives for exactly one lane. `body.allowRisky` is
      // not read at all — a service-token caller, an n8n workflow, and the managed CLI
      // helper all pause and wait for a click, the same as the model does.
      allowRisky: auth.auth === 'portable-skill',
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
      // SA-116 DL-116-07: a pause carries its card block at the TOP level of the body, not
      // only nested in `error.details`. send-routed's single `case 'tool-result'` loop — the
      // one every lane feeds — looks for `approvalRequest` there, so the CLI lanes and the
      // service lane get the same persisted card the SDK pause gives the API lane, with no
      // tab open. It is lifted rather than duplicated at the source so `useControl` keeps
      // one shape for every caller.
      const approvalRequest =
        result.error.code === 'CONTROL_RISK_REQUIRES_APPROVAL'
          ? (result.error.details?.approvalRequest ?? null)
          : null
      if (approvalRequest && !messageId) {
        console.warn(
          `[Controls Use] Paused "${result.controlId}" for approval, but no message id was ` +
            'verified for this call, so no approval card can render. The managed CLI ' +
            'profiles forward BATSHIT_MESSAGE_ID — regenerate them if this persists.'
        )
      }
      return json(
        {
          auth: auth.auth,
          userId: auth.userId,
          ...result,
          ...(approvalRequest ? { approvalRequest } : {})
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
