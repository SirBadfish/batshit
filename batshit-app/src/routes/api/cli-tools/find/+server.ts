import { json, type RequestHandler } from '@sveltejs/kit'

import { findCliTools } from '$lib/server/services/cliToolRegistry'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'

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

    const result = await findCliTools({
      userId,
      agentId: body.agentId ?? null,
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
