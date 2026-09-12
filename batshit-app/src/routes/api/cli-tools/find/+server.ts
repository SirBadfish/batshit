import { json, type RequestHandler } from '@sveltejs/kit'

import { findCliTools } from '$lib/server/services/cliToolRegistry'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { bindActingAgentId } from '$lib/server/services/actingAgentIdentity'

interface FindRequest {
  userId?: string
  agentId?: string | null
  selectedToolIds?: string[]
  query?: string
  limit?: number
  includeSchema?: boolean
}

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    const body = (await request.json()) as FindRequest
    const auth = await resolveNativeToolUser({
      request,
      localsUserId: locals.user?.id ?? null,
      claimedUserId: body.userId ?? null
    })
    const userId = auth?.userId

    if (!userId) {
      return json({ error: 'Unauthorized' }, { status: 401 })
    }

    // SA-117 DL-117-04: the bound agent wins on the agent lane; a differing claim is a 400.
    const agentBinding = bindActingAgentId(auth, body.agentId)
    if (!agentBinding.ok) {
      return json(
        { error: agentBinding.message, code: agentBinding.code },
        { status: 400 }
      )
    }

    const result = await findCliTools({
      userId,
      agentId: agentBinding.agentId ?? null,
      selectedToolIds: body.selectedToolIds,
      query: body.query,
      limit: body.limit,
      includeSchema: body.includeSchema
    })
    return json(result)
  } catch (error) {
    console.error('[CLI Tools Find API] Failed:', error)
    return json({ error: 'Failed to search CLI tools' }, { status: 500 })
  }
}
