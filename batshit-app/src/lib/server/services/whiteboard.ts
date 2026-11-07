import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { isMessageOfRunningRequest, isSessionDeleting } from '$lib/server/services/streamAbortRegistry'
import { resolveBrokerToolToggles } from '$lib/utils/brokerAvailability'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveApiReasoningRetention, estimateWhiteboardTokens, type ResolvedReasoningRetention } from '$lib/utils/reasoningRetention'
import { readWhiteboardRecord, type WhiteboardRecord } from '$lib/utils/whiteboard'
import { WRITE_WHITEBOARD_SCRIPT } from '$lib/server/whiteboardScripts'

export const whiteboardKey = (sessionId: string, agentId: string) => `whiteboard:${sessionId}:${agentId}`
export type WhiteboardOwner = { userId: string; sessionId: string; agentId: string }

export async function readAgentWhiteboard(owner: WhiteboardOwner): Promise<WhiteboardRecord | null> {
  return readWhiteboardRecord(await redis.json.get(whiteboardKey(owner.sessionId, owner.agentId)), owner)
}

export async function updateAgentWhiteboard(context: {
  userId: string; sessionId?: string | null; agentId?: string | null; messageId?: string | null
  actorType?: string; abortSignal?: AbortSignal
  whiteboardSettingsSnapshot?: ResolvedReasoningRetention
}, input: { content: string | null; expectedVersion: number }): Promise<Record<string, any>> {
  const { userId, sessionId, agentId, messageId, whiteboardSettingsSnapshot: snapshot } = context
  const checkActive = () => {
    if (context.actorType !== 'in-process' || !sessionId || !agentId || !messageId ||
        !snapshot?.whiteboardEnabled || context.abortSignal?.aborted ||
        isSessionDeleting(sessionId) || !isMessageOfRunningRequest(sessionId, messageId)) {
      throw new Error('Whiteboard updates require this agent’s active, enabled reply. Nothing was written.')
    }
  }
  checkActive()
  const owner = { userId, sessionId: sessionId!, agentId: agentId! }
  const [agent, session] = await Promise.all([
    redis.json.get(`agent:${agentId}`), redis.json.get(`session:${sessionId}`)
  ])
  if (!agent || !session || agent.user_id !== userId || session.user_id !== userId ||
      normalizePrimaryAgentType(agent) !== 'api' || session.metadata?.group_chat ||
      !resolveBrokerToolToggles(agent.provider_specific_settings).batshitToolsEnabled) {
    throw new Error('Whiteboard owner or API tool access is unavailable. Nothing was written.')
  }
  const live = resolveApiReasoningRetention(agent)
  if (!live.whiteboardEnabled) throw new Error('Whiteboard is disabled. Stored notes were kept; nothing was written.')
  const limit = Math.min(snapshot!.whiteboardBudgetTokens, live.whiteboardBudgetTokens)
  const content = input.content === null ? null : input.content.trim() || null
  const tokens = estimateWhiteboardTokens(content ?? '')
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('expectedVersion must be a nonnegative integer.')
  if (tokens > limit) throw new Error(`Whiteboard replacement uses ${tokens} estimated tokens; the current limit is ${limit}. Shorten it and retry. The saved board was kept.`)
  // Bind admission to the fields actually read. A concurrent setting edit refuses instead of
  // applying a write under stale enablement/budget. Display edits do not affect this gate.
  const paths = ['$.api_reasoning_retention', '$.whiteboard_budget_tokens', '$.agentType']
  const preimages = await Promise.all(paths.map((path) => redis.json.getRaw(`agent:${agentId}`, path)))
  // The preimages must describe the same settings as the resolved reads above.
  const valueAt = (raw: string | null) => raw ? (JSON.parse(raw) as unknown[])[0] : undefined
  if (JSON.stringify(valueAt(preimages[0])) !== JSON.stringify(agent.api_reasoning_retention) ||
      JSON.stringify(valueAt(preimages[1])) !== JSON.stringify(agent.whiteboard_budget_tokens) ||
      JSON.stringify(valueAt(preimages[2])) !== JSON.stringify(agent.agentType)) {
    throw new Error('Whiteboard settings changed during admission. Nothing was written; review current settings before retrying.')
  }
  checkActive()
  const answer = await redis.execute((client) => {
    checkActive()
    return client.eval(WRITE_WHITEBOARD_SCRIPT, {
    keys: [whiteboardKey(sessionId!, agentId!), `agent:${agentId}`, `session:${sessionId}`],
    arguments: [userId, sessionId!, agentId!, String(input.expectedVersion), JSON.stringify(content), String(limit), new Date().toISOString(),
      ...preimages.map((raw) => raw ?? '')]
    })
  })
  if (typeof answer !== 'string') throw new Error('Whiteboard persistence was not confirmed.')
  if (answer.startsWith('CONFLICT:')) {
    const current = readWhiteboardRecord(JSON.parse(answer.slice('CONFLICT:'.length)), owner)
    return { success: false, code: 'WHITEBOARD_CHANGED', error: 'The saved whiteboard changed. Nothing was written; reconcile the current content before retrying.', current,
      note: 'Nothing was written. Read the current board in this conflict result, reconcile it with your intended changes, then submit a complete replacement with its version. Do not blindly retry the old replacement.' }
  }
  if (['MISSING_OWNER', 'WRONG_OWNER', 'SETTINGS_CHANGED', 'OVER_BUDGET', 'GROUP_SESSION', 'TOOLS_DISABLED'].includes(answer)) throw new Error(`Whiteboard update refused (${answer}); nothing was written.`)
  const board = readWhiteboardRecord(JSON.parse(answer), owner)!
  await publishUserEvent(userId, { type: 'whiteboard_changed', sessionId: sessionId!, agentId: agentId!, version: board.version })
  return { success: true, version: board.version, updated_at: board.updated_at, estimatedTokens: tokens, budgetTokens: limit,
    note: content === null ? 'Whiteboard cleared. Naps and dreaming will not refill it.' : 'Whiteboard saved. The latest version is available on your next new turn.' }
}
