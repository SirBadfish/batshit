import { json, type RequestHandler } from '@sveltejs/kit'

import { executeCliTool } from '$lib/server/services/cliToolRegistry'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

interface ExecuteRequest {
  userId?: string
  agentId?: string | null
  toolId: string
  input?: Record<string, any>
  selectedToolIds?: string[]
  allowRisky?: boolean
  projectPath?: unknown
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

    const result = await executeCliTool({
      userId,
      agentId: body.agentId ?? null,
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
