import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { listAllDms, reapExpired } from '$lib/server/services/dm/dmStore'
import { getWokenRunForSession } from '$lib/server/services/dm/dmTools'
import { resolveAgentDmsEnabled } from '$lib/utils/dmControl'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { listActiveSessionTurns } from '$lib/server/services/streamAbortRegistry'
import { findWakeRunForAgent } from '$lib/server/services/wakeRunRegistry'
import { isOpenDmStatus, type DmRecord } from '$lib/types/dm'

/**
 * SA-113 P4 (DL-113-10a) — the inbox drawer's list.
 *
 * Cookie-only, and it is the USER's view of the DM traffic, not an agent's: it returns
 * every DM on the instance in one read so the drawer can switch tabs and agents without a
 * round trip. That is affordable because retention is 30 days and Batshit is one user per
 * instance; if that ever stops being true this is the route that has to start paging.
 *
 * Bodies are deliberately NOT here — a row shows a subject, and `GET /api/dms/{id}` is
 * what fetches the body when the user expands it. Same summary-first rule the `sys.dm.*`
 * family follows, for the same reason: most rows are never opened.
 */

/**
 * The drawer's "who is around" dot (DL-113-16), from the server's own registries.
 *
 * F-SEC-1b adds the third state: an agent holding an open DM stamped "needs you" reports
 * `waiting_approval` even when no turn is running, because that is precisely the case where
 * the turn ENDED and the holdup is a person. `needsUserAgentIds` comes from the DM list the
 * caller already read, so it costs no extra reads.
 */
async function listAgentPresence(userId: string, needsUserAgentIds: Set<string>) {
  const agents = await redis.getAgents(userId)
  const activeTurns = listActiveSessionTurns()

  const runningByAgent = new Map<string, string>()
  for (const turn of activeTurns) {
    const session = await redis.getSession(turn.sessionId)
    if (!session) continue
    const metadata = (session.metadata ?? {}) as Record<string, any>
    if (metadata.group_chat?.group_id) continue
    const agentId = session.agent_id || metadata.last_agent_id || metadata.agent_id || null
    if (typeof agentId !== 'string' || !agentId) continue
    if (!runningByAgent.has(agentId)) runningByAgent.set(agentId, turn.sessionId)
  }

  return agents
    .map((agent) => agent as unknown as Record<string, any>)
    .filter((agent) => {
      const type = normalizePrimaryAgentType(agent as any)
      return type === 'api' || type === 'cli'
    })
    .map((agent) => {
      const runningSessionId =
        runningByAgent.get(agent.id) ?? findWakeRunForAgent(agent.id)?.sessionId ?? null
      const needsUser = needsUserAgentIds.has(agent.id)
      return {
        id: agent.id,
        name:
          (typeof agent.displayName === 'string' && agent.displayName.trim()) ||
          (typeof agent.name === 'string' && agent.name.trim()) ||
          agent.id,
        dms_enabled: resolveAgentDmsEnabled(agent),
        state: needsUser
          ? ('waiting_approval' as const)
          : runningSessionId
            ? ('running' as const)
            : ('idle' as const),
        running_session_id: runningSessionId
      }
    })
}

/** Everything a row needs, minus the body and the result text. */
function toRow(record: DmRecord) {
  const wokenSessionId = record.delivery?.sessionId ?? null
  return {
    id: record.id,
    kind: record.kind,
    priority: record.priority,
    status: record.status,
    from: record.from,
    to: record.to,
    subject: record.subject,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    completedAt: record.completedAt ?? null,
    delivery: record.delivery,
    senderSessionId: record.senderSessionId ?? null,
    claimedSessionId: record.claimedBy?.sessionId ?? null,
    relatedDmId: record.relatedDmId ?? null,
    resultDmId: record.resultDmId ?? null,
    callbackStatus: record.callbackStatus ?? null,
    hasResult: typeof record.result === 'string' && record.result.length > 0,
    // A row is "live" only while the wake registry still owns that session's turn, which
    // is what makes the row's Stop button meaningful rather than decorative.
    runningSessionId: wokenSessionId && getWokenRunForSession(wokenSessionId) ? wokenSessionId : null
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return json({ success: false, error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const records = await listAllDms(locals.user.id)
    // The reaper is lazy by design (DL-113-02): every read is its chance to run, and the
    // drawer is the one read a user actually looks at.
    const reaped = await reapExpired(records)
    const needsUserAgentIds = new Set(
      reaped
        .filter((record) => record.delivery?.needsUser && isOpenDmStatus(record.status))
        .map((record) => record.to)
    )
    const [rows, agents] = [
      reaped.map(toRow),
      await listAgentPresence(locals.user.id, needsUserAgentIds)
    ]
    return json({ success: true, dms: rows, agents })
  } catch (error) {
    console.error('[Agent DMs] Could not list DMs:', error)
    return json({ success: false, error: 'Could not load Agent DMs.' }, { status: 500 })
  }
}
