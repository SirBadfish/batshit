import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  claimClaudeApproval,
  releaseClaudeApprovalClaim
} from '$lib/server/services/claudeApprovalRegistry'

/**
 * BL-496 (A7): the answers for a card this server is not waiting on. The card is the server's
 * (`claudeApprovalRegistry.ts`, fed by the permission helper's own events), never the id a
 * browser sends: an answer to anything else would sit in Redis with nobody to read it.
 */
const CLAIM_REFUSALS = {
  not_found: {
    status: 404,
    code: 'approval_not_waiting',
    error: 'This approval is not waiting any more: its reply ended. Ask the agent to try again.'
  },
  answered: {
    status: 409,
    code: 'approval_already_answered',
    error: 'This approval was already answered.'
  },
  ended: {
    status: 409,
    code: 'approval_expired',
    error: 'This approval has expired. Ask the agent to try again.'
  }
} as const

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

    // One synchronous claim before the write, so two clicks cannot both answer; a write that
    // fails lets go, so the user can answer again.
    const claim = claimClaudeApproval(sessionId, approvalId)
    if (!claim.ok) {
      const refusal = CLAIM_REFUSALS[claim.reason]
      return json({ error: refusal.error, code: refusal.code }, { status: refusal.status })
    }

    try {
      await redis.execute(async (client) => {
        const key = `toolApprovalResponse:${sessionId}:${approvalId}`
        await client.rPush(key, JSON.stringify({ approved, ...(reason ? { reason } : {}) }))
        await client.expire(key, 60 * 10)
      })
    } catch (error) {
      releaseClaudeApprovalClaim(sessionId, approvalId)
      throw error
    }

    return json({ success: true })
  } catch (error) {
    console.error('[ToolApprovals] Failed to submit approval response', error)
    return json({ error: 'Failed to submit approval response' }, { status: 500 })
  }
}
