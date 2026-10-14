import { commandModelCaptureResponse } from '$lib/server/services/commandModelCaptureResponse'
import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { bindDispatchContextIdentity, boundRunCredential } from '$lib/server/services/actingAgentIdentity'
import { nativeToolService } from '$lib/server/services/nativeTools'
import {
  getRunCredentialStopSignal,
  getRunningReplyStopSignal
} from '$lib/server/services/streamAbortRegistry'

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
    if (auth.auth === 'agent' && auth.delegated &&
      (!auth.processOwner || !auth.commandParentAgentId)) {
      return json({ success: false, error: {
        code: 'INVALID_CONTEXT', message: 'Delegated command owner unavailable.'
      } }, { status: 400 })
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

    let dispatchContext = boundContext.context
    // Only the delegated Bash helper is authorized to map its virtual runtime ID to
    // the stored physical owner. Other actions keep the original virtual binding.
    if (auth.auth === 'agent' && auth.delegated && body.action === 'bash_execute') {
      const owner = auth.processOwner!
      const parentAgentId = auth.commandParentAgentId!
      if (!dispatchContext || typeof dispatchContext !== 'object' || Array.isArray(dispatchContext) ||
        (owner.kind === 'agent' && owner.id !== parentAgentId)) {
        return json({ success: false, error: {
          code: 'INVALID_CONTEXT', message: 'Delegated command owner does not match its parent.'
        } }, { status: 400 })
      }
      // The virtual runtime ID has already passed the request-claim mismatch gate. Native
      // dispatch needs stored records to resolve settings, so replace it only now with the
      // owner and parent bound into this run's credential. Never use the body's owner claims.
      const { parent_agent_id: _claimedParent, ...safeContext } = dispatchContext as Record<string, unknown>
      dispatchContext = owner.kind === 'subagent'
        ? { ...safeContext, actor_type: 'subagent', agent_id: owner.id,
            parent_agent_id: parentAgentId }
        : { ...safeContext, actor_type: 'primary', agent_id: parentAgentId }
    }

    // A Stop of the reply running in the chat ends a command this call runs (2026-09-18): the
    // managed CLI helper's `batshit_server_bash_execute` and n8n Workflow Subagents come through
    // here. On the agent lane the run credential decides (BL-1321): a primary run hears only its
    // own reply's Stop (already aborted once that reply has ended or been replaced), a Subagent
    // or Worker run its chat's running reply. The n8n, session and service lanes keep the chat
    // their context names; no reply running, no Stop, as before.
    const abortSignal = auth.auth === 'agent'
      ? getRunCredentialStopSignal(boundRunCredential(auth))
      : getRunningReplyStopSignal(contextSessionId(dispatchContext))
    // BL-1322: a primary run whose own reply has stopped, ended or been replaced does nothing
    // here, whatever the action: a `cli:` or Fabric ref would otherwise reach its risk gate and
    // raise an approval record, and `artifact_use` reaches `useControl` without this Stop.
    // Subagent and Worker runs and the other lanes are not refused here.
    if (auth.auth === 'agent' && auth.delegated !== true && abortSignal?.aborted) {
      return json({ success: false, stopped: true, error: {
        code: 'CONTROL_CANCELLATION_REQUIRED',
        message: 'This reply has already stopped or ended, so nothing was done. Do not retry it.'
      } }, { status: 403 })
    }

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: auth.userId,
      action: body.action,
      payloadInput: body.input,
      context: dispatchContext,
      projectPath: dispatchProjectPath,
      // SA-117 / PR #106 review F-1: the lane travels with the call, so `useControl`'s
      // identity gate answers the same way here as on `/api/controls/use`.
      actorType: auth.auth,
      delegatedRun: auth.delegated === true,
      delegatedBashEnabled: auth.auth === 'agent' && auth.delegated === true
        ? auth.delegatedBashEnabled === true : undefined,
      // Credential-bound physical owner; body/context owner claims are never trusted.
      processOwner: auth.auth === 'agent' ? auth.processOwner : undefined,
      // BL-75: the Subagent or Worker a delegated run's credential names, for skill access.
      scopeAgentId: auth.auth === 'agent' ? (auth.scopeAgentId ?? null) : null,
      ...(auth.auth === 'agent' ? { mcpGatewayScope: auth.mcpGatewayScope ?? [] } : {}),
      // BL-686: the run's saved CLI tools come off the credential too, never the payload.
      ...(auth.auth === 'agent' ? { cliToolScope: auth.cliToolScope ?? [] } : {}),
      abortSignal
    })

    const statusCode =
      result.success || auth.auth === 'n8n-callback' ? 200 : statusForCode(result.error?.code)
    return commandModelCaptureResponse(
      { auth: auth.auth, ...result }, auth.auth === 'agent', statusCode
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
