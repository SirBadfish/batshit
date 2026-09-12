import { json, type RequestHandler } from '@sveltejs/kit'

import { executeCliTool } from '$lib/server/services/cliToolRegistry'
import { resolveApprovalCardTarget } from '$lib/server/services/controlApprovals'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

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
    const bodyProjectPath =
      typeof body.projectPath === 'string' && body.projectPath.trim().length > 0
        ? body.projectPath.trim()
        : null

    const { sessionId, messageId } = await resolveApprovalCardTarget({
      userId,
      sessionId: body.sessionId,
      messageId: body.messageId
    })

    const result = await executeCliTool({
      userId,
      agentId: body.agentId ?? null,
      sessionId,
      messageId,
      toolId: body.toolId,
      input: body.input ?? {},
      selectedToolIds: body.selectedToolIds,
      allowRisky: body.allowRisky === true,
      projectPath: auth.auth === 'service' ? bodyProjectPath : null
    })

    return json(result, { status: result.success ? 200 : result.code === 'NOT_FOUND' ? 404 : 200 })
  } catch (error) {
    console.error('[CLI Tools Execute API] Failed:', error)
    return json({ error: 'Failed to execute CLI tool' }, { status: 500 })
  }
}
