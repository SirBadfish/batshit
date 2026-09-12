import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { bindDispatchContextIdentity } from '$lib/server/services/actingAgentIdentity'
import { nativeToolService } from '$lib/server/services/nativeTools'

interface NativeAutomationDispatchRequest {
  userId?: string
  action?: unknown
  input?: unknown
  context?: unknown
  projectPath?: unknown
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
      claimedUserId: body.userId ?? null,
      payload: body
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
    const dispatchProjectPath =
      auth.projectPath ??
      // SA-117: the managed CLI helper moved from the service lane to the agent lane and
      // still sends the run's project path.
      (auth.auth === 'service' || auth.auth === 'agent' ? bodyProjectPath : null)

    /**
     * SA-117 DL-117-04 — the dispatch `context.agent_id` path.
     *
     * `nativeTools.ts` reads the acting agent out of this opaque context and resolves the
     * GOVERNING agent from it (`context.agent_id` for a primary actor, `parent_agent_id` for
     * a subagent one), then loads that agent's record and its provider settings. On the agent
     * lane the credential already says which agent is running, so the governing field is
     * bound to it and a differing claim is refused.
     */
    const boundContext = bindDispatchContextIdentity(auth, body.context)
    if (!boundContext.ok) {
      return json(
        {
          success: false,
          error: { code: boundContext.code, message: boundContext.message }
        },
        { status: 400 }
      )
    }

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: auth.userId,
      action: body.action,
      payloadInput: body.input,
      context: boundContext.context,
      projectPath: dispatchProjectPath,
      // SA-117 / PR #106 review F-1: the lane travels with the call, so `useControl`'s
      // identity gate answers the same way here as on `/api/controls/use`.
      actorType: auth.auth,
      delegatedRun: auth.delegated === true
    })

    const statusCode =
      result.success || auth.auth === 'n8n-callback' ? 200 : statusForCode(result.error?.code)
    return json(
      {
        auth: auth.auth,
        ...result
      },
      { status: statusCode }
    )
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
