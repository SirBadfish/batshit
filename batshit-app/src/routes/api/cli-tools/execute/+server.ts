import { commandModelCaptureResponse } from '$lib/server/services/commandModelCaptureResponse'
import { json, type RequestHandler } from '@sveltejs/kit'

import { executeCliTool } from '$lib/server/services/cliToolRegistry'
import { resolveApprovalCardTarget } from '$lib/server/services/controlApprovals'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import {
  bindActingAgentId,
  bindActingSessionId,
  boundRunCredential
} from '$lib/server/services/actingAgentIdentity'
import { getRunCredentialStopSignal } from '$lib/server/services/streamAbortRegistry'

interface ExecuteRequest {
  userId?: string
  agentId?: string | null
  toolId: string
  input?: Record<string, any>
  selectedToolIds?: string[]
  allowRisky?: boolean
  projectPath?: unknown
  /**
   * SA-116 DL-116-07/DL-116-14 — the chat and the assistant message a pause pins its card
   * to. The managed CLI helper forwards both from `BATSHIT_SESSION_ID` /
   * `BATSHIT_MESSAGE_ID`; both are verified against this user before they are used, so a
   * risky user-authored CLI tool gets the same Approve button a risky Fabric control does
   * instead of a pause with nowhere to render.
   */
  sessionId?: unknown
  messageId?: unknown
}

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    const body = (await request.json()) as ExecuteRequest
    if (!body.toolId?.trim()) {
      return json({ error: 'toolId is required' }, { status: 400 })
    }

    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })
    const userId = auth?.userId

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (auth.auth === 'agent' && auth.delegated && !auth.processOwner) {
      return json({ error: 'Delegated command owner unavailable', code: 'OWNER_UNAVAILABLE' }, { status: 403 })
    }
    const bodyProjectPath =
      typeof body.projectPath === 'string' && body.projectPath.trim().length > 0
        ? body.projectPath.trim()
        : null

    // SA-117 DL-117-04: the bound agent and the bound session win on the agent lane.
    const agentBinding = bindActingAgentId(auth, body.agentId)
    if (!agentBinding.ok) {
      return json({ error: agentBinding.message, code: agentBinding.code }, { status: 400 })
    }

    // The Stop of the reply that made this call: the managed CLI helper runs every `cli:` ref
    // and `batshit_server_cli_tool_use` here, and its request cannot carry a Stop (SvelteKit
    // aborts `request.signal` only before the body is read). It comes from the run credential
    // (BL-1321): a primary run hears only its own reply's Stop (already aborted once that reply
    // has ended or been replaced), a Subagent or Worker run its chat's running reply (the
    // parent's). Unlike the dispatch and Agent Browser, which take the chat from the body on
    // lanes with no credential, a caller on any other lane gets no Stop.
    const abortSignal = getRunCredentialStopSignal(boundRunCredential(auth))
    // BL-1322: a primary run whose own reply has stopped, ended or been replaced does nothing.
    // Refused here, before the approval card target, the tool's risk gate (no approval record)
    // and its process; the rule `useControl` applies to Fabric controls. Subagent and Worker
    // runs and every other lane are not refused here.
    if (auth.auth === 'agent' && auth.delegated !== true && abortSignal?.aborted) {
      return json({
        success: false,
        stopped: true,
        code: 'CONTROL_CANCELLATION_REQUIRED',
        error: 'This reply has already stopped or ended, so the tool was not run. Do not retry it.'
      }, { status: 403 })
    }

    const { sessionId, messageId } = await resolveApprovalCardTarget({
      userId,
      sessionId: bindActingSessionId(auth, body.sessionId),
      messageId: auth.auth === 'agent' ? auth.messageId : body.messageId
    })

    const result = await executeCliTool({
      userId,
      agentId: agentBinding.agentId ?? null,
      sessionId,
      messageId,
      toolId: body.toolId,
      input: body.input ?? {},
      // BL-686: a managed run reaches only the saved CLI tools its credential names. The body's
      // list is a filter on that list (or on the named agent's saved list), never a new one.
      ...(auth.auth === 'agent' ? { cliToolScope: auth.cliToolScope ?? [] } : {}),
      selectedToolIds: body.selectedToolIds,
      allowRisky: body.allowRisky === true,
      // PR #106 review F-5: the lane decides where the approval card lands.
      actorType: auth.auth,
      // A command owner comes from the minted credential, never request JSON.
      processOwner: auth.auth === 'agent' ? auth.processOwner : undefined,
      // SA-117: the managed CLI helper moved from the service lane to the agent lane and
      // still sends the run's project path, so the agent lane reads it the same way.
      projectPath: auth.auth === 'service' || auth.auth === 'agent' ? bodyProjectPath : null
    }, { abortSignal })

    return commandModelCaptureResponse(result, auth.auth === 'agent', result.success ? 200 : result.code === 'NOT_FOUND' ? 404 : result.code === 'OWNER_UNAVAILABLE' ? 403 : 200)
  } catch (error) {
    console.error('[CLI Tools Execute API] Failed:', error)
    return json({ error: 'Failed to execute CLI tool' }, { status: 500 })
  }
}
