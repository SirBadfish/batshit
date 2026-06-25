import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  applyManualTrimToMessages,
  countProtectedManualTrimCandidates,
  extendTrimmedMessageIds,
  isMessageProtectedFromManualTrim
} from '$lib/utils/tokenPanel'
import {
  estimateCompiledTokens,
  loadAssignedSubagents,
  loadContextProtections,
  normalizeMessages,
  normalizeStringArray,
  resolveCliWrapperOverhead,
  resolveRuntimeFlavor,
  type AgentRow
} from '$lib/server/services/contextTokenPreview'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import {
  applyContextCompactionToMessages,
  getContextCompactionState
} from '$lib/utils/contextCompaction'

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  try {
    const body = await request.json()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    const tokensToTrim =
      typeof body?.tokensToTrim === 'number' && Number.isFinite(body.tokensToTrim)
        ? Math.max(0, Math.round(body.tokensToTrim))
        : 50_000

    if (!sessionId || !agentId) {
      return json({ error: 'Session ID and agent ID are required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    const agent = await redis.get(`agent:${agentId}`) as AgentRow | null
    if (!agent || agent.user_id !== user.value.id) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    const rawMessages = normalizeMessages(body?.messages)
    const compactionState = getContextCompactionState(sessionCheck.value.metadata ?? null)
    const messages = applyContextCompactionToMessages(rawMessages, compactionState.events)
    if (messages.length <= 1) {
      return json({
        nextTrimmedMessageIds: normalizeStringArray(body?.trimmedMessageIds),
        newlyTrimmedMessageIds: [],
        newlyTrimmedMessageCount: 0,
        totalTrimmedMessageCount: normalizeStringArray(body?.trimmedMessageIds).length,
        beforeTokens: null,
        afterTokens: null,
        estimatedFreedTokens: 0,
        protectedMessageCount: 0,
        noticeContent: null
      })
    }

    const [protections, assignedSubagents] = await Promise.all([
      loadContextProtections(sessionId),
      loadAssignedSubagents(agent)
    ])
    const messagesById = new Map(messages.map((message) => [message.id, message]))
    const currentTrimmedMessageIds = normalizeStringArray(body?.trimmedMessageIds).filter((id) => {
      const message = messagesById.get(id)
      return message && !isMessageProtectedFromManualTrim(message, protections)
    })
    const protectedMessageCount = countProtectedManualTrimCandidates(messages, protections)
    const runtimeFlavor = resolveRuntimeFlavor(agent, body?.agentType)
    const wrapperOverheadTokens = resolveCliWrapperOverhead(agent, body?.agentType)

    const baseMessages = applyManualTrimToMessages(messages, currentTrimmedMessageIds, {
      protections,
      sessionId,
      userId: user.value.id
    })
    const beforeTokens = await estimateCompiledTokens({
      sessionId,
      messages: baseMessages,
      agent,
      userId: user.value.id,
      assignedSubagents,
      runtimeFlavor,
      wrapperOverheadTokens,
      eventFetch
    })

    let nextTrimmedMessageIds = extendTrimmedMessageIds(
      messages,
      currentTrimmedMessageIds,
      tokensToTrim,
      { protections }
    )

    if (nextTrimmedMessageIds.length === currentTrimmedMessageIds.length) {
      return json({
        nextTrimmedMessageIds,
        newlyTrimmedMessageIds: [],
        newlyTrimmedMessageCount: 0,
        totalTrimmedMessageCount: nextTrimmedMessageIds.length,
        beforeTokens,
        afterTokens: beforeTokens,
        estimatedFreedTokens: 0,
        protectedMessageCount,
        wrapperOverheadTokens,
        noticeContent: null
      })
    }

    let afterTokens = beforeTokens
    let attempts = 0
    while (attempts < 50) {
      const afterMessages = applyManualTrimToMessages(messages, nextTrimmedMessageIds, {
        protections,
        sessionId,
        userId: user.value.id
      })
      afterTokens = await estimateCompiledTokens({
        sessionId,
        messages: afterMessages,
        agent,
        userId: user.value.id,
        assignedSubagents,
        runtimeFlavor,
        wrapperOverheadTokens,
        eventFetch
      })

      const estimatedFreedTokens = Math.max(0, beforeTokens - afterTokens)
      if (estimatedFreedTokens >= tokensToTrim) break

      const extended = extendTrimmedMessageIds(messages, nextTrimmedMessageIds, 1, {
        protections,
        maxNewMessages: 1
      })
      if (extended.length === nextTrimmedMessageIds.length) break
      nextTrimmedMessageIds = extended
      attempts += 1
    }

    const newlyTrimmedMessageIds = nextTrimmedMessageIds.filter(
      (id) => !currentTrimmedMessageIds.includes(id)
    )
    const noticeMessage = applyManualTrimToMessages(messages, nextTrimmedMessageIds, {
      protections,
      sessionId,
      userId: user.value.id
    }).find((message) => message.metadata?.manualContextTrim)

    return json({
      nextTrimmedMessageIds,
      newlyTrimmedMessageIds,
      newlyTrimmedMessageCount: newlyTrimmedMessageIds.length,
      totalTrimmedMessageCount: nextTrimmedMessageIds.length,
      beforeTokens,
      afterTokens,
      estimatedFreedTokens: Math.max(0, beforeTokens - afterTokens),
      protectedMessageCount,
      wrapperOverheadTokens,
      noticeContent: noticeMessage?.content ?? null
    })
  } catch (error) {
    console.error('[trim-preview] Failed to build manual trim preview:', error)
    return json({ error: 'Failed to build manual trim preview' }, { status: 500 })
  }
}
