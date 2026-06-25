import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const payload = await request.json()
    const approvalId =
      typeof payload?.approvalId === 'string' ? payload.approvalId.trim() : ''
    const sessionId =
      typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
    const approved = payload?.approved === true
    const reason =
      typeof payload?.reason === 'string' && payload.reason.trim().length > 0
        ? payload.reason.trim()
        : undefined

    if (!approvalId || !sessionId) {
      return json({ error: 'Missing approvalId or sessionId' }, { status: 400 })
    }

    const session = await redis.get(`session:${sessionId}`)
    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }

    if (session.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    await redis.execute(async (client) => {
      const key = `toolApprovalResponse:${sessionId}:${approvalId}`
      await client.rPush(key, JSON.stringify({ approved, ...(reason ? { reason } : {}) }))
      await client.expire(key, 60 * 10)
    })

    return json({ success: true })
  } catch (error) {
    console.error('[ToolApprovals] Failed to submit approval response', error)
    return json({ error: 'Failed to submit approval response' }, { status: 500 })
  }
}
