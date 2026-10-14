import { redis } from '$lib/server/redis'
import { createZipFromContent } from '$lib/server/zipService'
import { isSessionDeleting } from './streamAbortRegistry'
import { reserveToolModelRetainedCopy } from './toolModelRetentionTurnBudget'
import { canRunFetchItsKeptCopy } from './fetchZipForModel'
import { formatToolModelTextCut, planToolModelTextCut, type ToolModelTextBudget } from '$lib/utils/toolModelTextSizeGuard'

/** All identity fields come from an in-process turn or a verified run credential. */
export interface ToolModelResultContext {
  userId: string
  sessionId: string
  messageId: string
  agentId: string
  toolName?: string
  /** Size accounting only, for a bounded helper transfer. Never grants identity or Fetch Zip. */
  originalTextChars?: number
  /** Resolved by the server from this run's tool scope, never from helper request JSON. */
  fetchZipAllowed?: boolean
  modelTextBudget?: ToolModelTextBudget
  /** Internal server-classified identity only; never an endpoint body flag. */
  memoryResult?: boolean
}

async function removeUndeliveredCopy(zipId: string, sessionId: string): Promise<boolean> {
  let deleted = false
  await redis.execute(async (client) => {
    // Preserve the deletion index if DEL fails; otherwise chat deletion would lose the raw zip.
    await client.del(`zip:${zipId}`)
    deleted = true
    await client.sRem(`session:${sessionId}:zips`, zipId)
  }).catch(() => console.error('[Tool result guard] Could not remove an undelivered raw copy.', {
    zipId, sessionId
  }))
  return deleted
}

/**
 * Retain server-owned text independently of whether it needs cutting. This existing zip
 * primitive is also available to a future delegated-result policy; it creates no card or
 * trusted reference. Callers must belong to the chat's registered running request.
 */
export async function retainToolModelText(
  text: string, context: ToolModelResultContext
): Promise<{ zipId: string; releaseBudget: () => void; readableByRun: boolean } | null> {
  if (!context || [context.userId, context.sessionId, context.messageId, context.agentId]
    .some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('This tool result is too large to deliver, and its owning chat, reply, or agent is missing.')
  }
  const session = await redis.getSession(context.sessionId)
  if (!session || session.user_id !== context.userId || isSessionDeleting(context.sessionId)) {
    throw new Error('This tool result cannot be retained because its owning chat is unavailable.')
  }
  const plan = planToolModelTextCut(text, context.originalTextChars)
  const reservation = reserveToolModelRetainedCopy(context)
  if (!reservation) return null
  let retained: { zipId: string } | null = null
  try {
    retained = await createZipFromContent(
      plan.rawText, 'tool_raw', context.sessionId, context.messageId,
      {
        userId: context.userId, agentId: context.agentId, retainedForSizeGuard: true,
        modelTextChars: plan.totalChars, retainedChars: plan.rawText.length,
        droppedChars: plan.rawDroppedChars,
        ...(context.toolName ? { toolName: context.toolName } : {})
      },
      { indexedRetention: true }
    )
    const currentSession = await redis.getSession(context.sessionId)
    if (isSessionDeleting(context.sessionId) || !currentSession || currentSession.user_id !== context.userId) {
      throw new Error('The chat is being deleted; its tool result was not delivered.')
    }
    reservation.commit()
    return {
      zipId: retained.zipId,
      releaseBudget: reservation.rollback,
      readableByRun: canRunFetchItsKeptCopy(currentSession, context.sessionId, context.messageId)
    }
  } catch (error) {
    // A copy that could not be removed still consumes its slot. A stale index after a
    // successful DEL does not: the raw data is gone and the delete sweep can clear it.
    if (!retained || await removeUndeliveredCopy(retained.zipId, context.sessionId)) reservation.rollback()
    throw error
  }
}

/** Save before announcing an id. The raw copy and the model's cut view have distinct owners. */
export async function guardToolModelText(text: string, context: ToolModelResultContext): Promise<string> {
  if (!planToolModelTextCut(text, context.originalTextChars, context.modelTextBudget).cut) return text
  if (context.memoryResult === true) return formatToolModelTextCut(text, { kind: 'memory' }, context.originalTextChars, context.modelTextBudget).text
  const retained = await retainToolModelText(text, context)
  if (!retained) return formatToolModelTextCut(text, { kind: 'not-retained' }, context.originalTextChars, context.modelTextBudget).text
  try {
    // BL-680: name the id only when this run's own Fetch Zip will accept it.
    return formatToolModelTextCut(text, context.fetchZipAllowed !== true
      ? { kind: 'unavailable' }
      : retained.readableByRun
        ? { kind: 'fetchable', zipId: retained.zipId }
        : { kind: 'group-unreadable' }, context.originalTextChars, context.modelTextBudget).text
  } catch (error) {
    if (await removeUndeliveredCopy(retained.zipId, context.sessionId)) retained.releaseBudget()
    throw error
  }
}
