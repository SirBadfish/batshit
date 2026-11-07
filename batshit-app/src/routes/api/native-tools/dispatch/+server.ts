import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { nativeToolService } from '$lib/server/services/nativeTools'
import { getRunningReplyStopSignal } from '$lib/server/services/streamAbortRegistry'

interface NativeAutomationDispatchRequest {
  userId?: string
  action?: unknown
  input?: unknown
  context?: unknown
  projectPath?: unknown
}

/** The chat a (bound) dispatch context names; the dispatcher validates the rest of it. */
function contextSessionId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
  const sessionId = (context as Record<string, unknown>).session_id
  return typeof sessionId === 'string' ? sessionId : undefined
}

function statusForCode(code?: string): number {
  switch (code) {
    case 'INVALID_ACTION':
    case 'INVALID_INPUT':
    case 'INVALID_CONTEXT':
      return 400
    case 'ACTION_DISABLED':
    case 'POLICY_BLOCKED':
      return 403
    case 'SANDBOX_UNAVAILABLE':
    case 'BACKEND_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json().catch(() => null)) as NativeAutomationDispatchRequest | null
    if (!body || typeof body !== 'object') {
      return json(
        {
          success: false,
          error: {
            code: 'INVALID_INPUT',
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
            code: 'INVALID_CONTEXT',
            message: 'Unauthorized'
          }
        },
        { status: 401 }
      )
    }
    const bodyProjectPath =
      typeof body.projectPath === 'string' && body.projectPath.trim().length > 0
        ? body.projectPath.trim()
        : null
    const dispatchProjectPath = auth.auth === 'service' ? bodyProjectPath : null
    const dispatchContext = body.context
    const abortSignal = getRunningReplyStopSignal(contextSessionId(dispatchContext))

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: auth.userId,
      action: body.action,
      payloadInput: body.input,
      context: dispatchContext,
      projectPath: dispatchProjectPath,
      // SA-117 / PR #106 review F-1: the lane travels with the call, so `useControl`'s
      // identity gate answers the same way here as on `/api/controls/use`.
      actorType: auth.auth,
      abortSignal
    })

    const statusCode = result.success ? 200 : statusForCode(result.error?.code)
    return json({ auth: auth.auth, ...result }, { status: statusCode })
  } catch (error) {
    console.error('[Native Tools] dispatch failed:', error)
    return json(
      {
        success: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Native tool dispatch failed.'
        }
      },
      { status: 500 }
    )
  }
}
