import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import type { AgentRow } from '$lib/types/database'
import { isFixedSession } from '$lib/utils/fixedSession'
import {
  buildCompactionTranscript,
  buildLiveProtectedItemsNote,
  COMPACT_PENDING_APPROVAL_MESSAGE,
  getCompactedMessageIds,
  getContextCompactionState,
  hasPendingCompactApproval,
  normalizeGlobalAutoCompactSettings,
  resolveCompactSummaryBudget,
  resolveEffectiveAutoCompactSettings,
  selectMessagesForCompaction,
  type AutoCompactEventMode,
  type ContextCompactionEvent,
  type EffectiveAutoCompactSettings
} from '$lib/utils/contextCompaction'
import { countTotalTokens } from '$lib/utils/tokenCounter'
import {
  estimateCurrentContextTokens,
  loadContextProtections,
  normalizeMessages,
  normalizeStringArray
} from '$lib/server/services/contextTokenPreview'
// SA-104 P6: the model-resolution + generation ladder moved verbatim into the shared
// summary-generation service so memory graduation and the nap use the same rules.
import { generateModelSummary } from '$lib/server/services/summaryGeneration'
import { resolveCompiledSpeakerView } from '$lib/server/services/compiledSpeakerView'
import { isTurnRunning } from '$lib/server/services/turnYield'
import { hasTurnStartedAfter, lastTurnStartOf } from '$lib/server/services/streamAbortRegistry'
import { isMessageProtectedFromManualTrim } from '$lib/utils/tokenPanel'
import { startCompactRun, type CompactRun } from '$lib/server/services/compactRunRegistry'
import type { PlanLease } from '$lib/server/services/chatgptPlanRuntime'
import { getChatgptPlanRuntime } from '$lib/server/services/chatgptPlanHost'
import { chatgptPlanHttpStatus } from '$lib/server/services/chatgptPlanInference'
import { normalizeGroupChatConfig } from '$lib/server/services/groupChatUtils'

type AgentRecord = AgentRow & Record<string, any>

const APPROVAL_READ_BATCH_SIZE = 16
const APPROVAL_READ_PATHS = ['$.role', '$.metadata.toolApprovals', '$.metadata.answeredApprovalIds']

/** The ordinary history readers skip failed records; admission must not miss a visible card. */
async function chatHasPendingApproval(sessionId: string, events: ContextCompactionEvent[]): Promise<boolean> {
  const compacted = new Set(getCompactedMessageIds(events))
  return redis.execute(async (client) => {
    const ids = (await client.lRange(`messages:${sessionId}`, 0, -1)).filter((id) => !compacted.has(id))
    for (let start = 0; start < ids.length; start += APPROVAL_READ_BATCH_SIZE) {
      const messages = await Promise.all(ids.slice(start, start + APPROVAL_READ_BATCH_SIZE).map(async (id) => {
        const key = `message:${sessionId}:${id}`
        try {
          const fields = await client.json.get(key, { path: APPROVAL_READ_PATHS })
          if (fields === null) return null // A deleted message's old list entry is not a card.
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
            throw new Error('Unexpected RedisJSON approval read shape')
          }
          const first = (path: string) => {
            const matches = (fields as Record<string, unknown>)[path]
            if (!Array.isArray(matches) || matches.length > 1) {
              throw new Error(`Unexpected RedisJSON matches for ${path}`)
            }
            return matches[0] // Missing fields are [] on Redis, [null] on the default fake.
          }
          return { id, role: first('$.role'), metadata: {
            toolApprovals: first('$.metadata.toolApprovals'),
            answeredApprovalIds: first('$.metadata.answeredApprovalIds')
          } }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`Could not read Compact approval state for ${key}: ${reason}`)
        }
      }))
      if (hasPendingCompactApproval(messages.filter((message) => message !== null))) return true
    }
    return false
  })
}

function pendingApprovalAnswer() {
  return json(
    { error: COMPACT_PENDING_APPROVAL_MESSAGE, code: 'approval_pending' },
    { status: 409 }
  )
}

function buildCompactPrompt(params: {
  settings: EffectiveAutoCompactSettings
  transcript: string
  liveProtectedNote: string
  summarySoftTargetTokens: number
  summaryHardMaxTokens: number
}) {
  const protectedBlock = params.liveProtectedNote
    ? `\n\nLIVE ITEMS THAT STAY OUTSIDE THE SUMMARY:\n${params.liveProtectedNote}`
    : ''

  return [
    params.settings.prompt,
    protectedBlock,
    '',
    'SUMMARY BUDGET:',
    `Aim for roughly ${params.summarySoftTargetTokens.toLocaleString()} tokens when that is enough to preserve continuity. Do not exceed about ${params.summaryHardMaxTokens.toLocaleString()} tokens unless the alternative would lose important live task state. The exact number is not the goal; useful continuity is the goal.`,
    '',
    'OLD CONVERSATION SEGMENT TO COMPACT:',
    params.transcript
  ].join('\n')
}

/** BL-622 (C7): the answer of a Compact its chat's Stop ended. Nothing was written. */
function stoppedAnswer() {
  return json(
    { error: 'Compact stopped. It wrote nothing.', code: 'ended_early', reason: 'stopped' },
    { status: 409 }
  )
}

/**
 * BL-622 (C4): the answer of a Compact that looked again after its summary call and found the chat
 * changed under it. Nothing was written. The page words it for the user (`compactEndedEarly.ts`).
 */
function endedEarlyAnswer(reason: 'turn_started' | 'message_protected') {
  const error =
    reason === 'turn_started'
      ? 'A reply started in this chat. This Compact wrote nothing.'
      : 'A message this Compact summarized is now protected. This Compact wrote nothing.'
  return json({ error, code: 'ended_early', reason }, { status: 409 })
}

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  // BL-622 (C6, C7): a running Compact is registered so its chat's Stop can end it
  // (`POST /api/messages/compact/stop`); it leaves the registry on every path (the `finally`).
  let compactRun: CompactRun | null = null
  let planLease: PlanLease | undefined
  try {
    const body = await request.json()
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    const mode: AutoCompactEventMode = body?.mode === 'auto' ? 'auto' : 'manual'
    const previewOnly = body?.previewOnly === true

    if (!sessionId || !agentId) {
      return json({ error: 'Session ID and agent ID are required' }, { status: 400 })
    }

    const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
    if (!sessionCheck.ok) return sessionCheck.response

    // BL-719: register right after the ownership check, not after the reads, the token estimate,
    // and the speaker view. A Stop pressed during that setup must be seen before the model call,
    // not only after it — the `finally` below ends this run on every exit, early or not.
    compactRun = startCompactRun(sessionId)

    const [session, agent, userSettings, protections] = await Promise.all([
      redis.getSession(sessionId),
      redis.get(`agent:${agentId}`) as Promise<AgentRecord | null>,
      redis.getUserSettings(user.value.id),
      loadContextProtections(sessionId)
    ])

    if (!session) {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    if (!agent || agent.user_id !== user.value.id) {
      return json({ error: 'Agent not found' }, { status: 404 })
    }

    // SA-104 P6 (DL-104-07): Infinite Sessions never use plain Compact — relief happens
    // through episode graduation and naps, which preserve originals in searchable
    // memory. The client hides the button; this is the server backstop.
    if (isFixedSession(session)) {
      return json(
        {
          error:
            'Infinite Sessions do not use Compact. Context relief happens through episode graduation and naps, which keep the originals searchable.',
          code: 'FIXED_SESSION_COMPACT_UNSUPPORTED'
        },
        { status: 409 }
      )
    }

    // BL-622 (C3): a Compact does not start beside a turn. The user's message goes first, and
    // the Compact runs again after the reply (Auto Compact's idle check sees the same threshold).
    // The preview is refused too, so a pressed Compact learns it before its confirm step.
    if (isTurnRunning(sessionId)) {
      return json(
        { error: 'A reply is running in this chat. Compact runs after it.', code: 'turn_running' },
        { status: 409 }
      )
    }
    // BL-622 (C4): read in the same synchronous step as the check above, so the look before the
    // write sees every turn that started after it, also one that started AND ended meanwhile.
    const seenTurnId = lastTurnStartOf(sessionId)

    // BL-711: Compact hides its source messages in both views. A pending card and the
    // words held for it must stay visible, including the card's existing expiry handler.
    // The request's messages can be stale or omit the card, so only persisted state admits it.
    const compactionState = getContextCompactionState(session.metadata ?? null)
    const groupId = typeof session.metadata?.group_chat?.group_id === 'string'
      ? session.metadata.group_chat.group_id : null
    const group = groupId
      ? await redis.execute(async (client) => client.json.get(`group:${groupId}`)) as { user_id?: unknown; agent_ids?: unknown } | null
      : null
    const groupConfig = group && group.user_id === user.value.id
      ? normalizeGroupChatConfig({ enabled: true, agent_ids: group.agent_ids }) : null
    // Exactly the existing group-runner threshold. Groups cannot answer old/converted
    // cards or hold steer words; the dead card must not newly disable their Compact.
    const groupRunnerSession = Boolean(
      groupConfig && Array.isArray(groupConfig.agent_ids) && groupConfig.agent_ids.length >= 2
    )
    if (!groupRunnerSession && await chatHasPendingApproval(sessionId, compactionState.events)) return pendingApprovalAnswer()

    const globalSettings = normalizeGlobalAutoCompactSettings(
      userSettings?.global_auto_compact_settings
    )
    const effectiveSettings = resolveEffectiveAutoCompactSettings({
      global: globalSettings,
      agent: agent.auto_compact_settings
    })

    if (mode === 'auto' && effectiveSettings.mode === 'off') {
      return json({ error: 'Auto Compact is disabled for this agent.' }, { status: 400 })
    }

    const messagesFromBody = normalizeMessages(body?.messages)
    const messages = messagesFromBody.length > 0
      ? messagesFromBody
      : await redis.getSessionMessages(sessionId)

    const selection = selectMessagesForCompaction(messages, compactionState.events, {
      protections
    })

    if (selection.compactedMessageCount <= 0) {
      return json({
        error: 'No older unprotected messages are available to compact.',
        code: 'no_compaction_candidates',
        protectedMessageCount: selection.protectedMessageCount
      }, { status: 400 })
    }

    const beforeEstimate = await estimateCurrentContextTokens({
      sessionId,
      messages,
      agent,
      userId: user.value.id,
      agentTypeHint: typeof body?.agentType === 'string' ? body.agentType : undefined,
      trimmedMessageIds: Array.isArray(body?.trimmedMessageIds) ? body.trimmedMessageIds : [],
      eventFetch
    })
    const summaryBudget = resolveCompactSummaryBudget({
      contextLimit: beforeEstimate.budget.contextLimit,
      sourceTokenEstimate: selection.sourceTokenEstimate
    })

    if (previewOnly) {
      return json({
        success: true,
        previewOnly: true,
        selection,
        compactedMessageIds: selection.sourceMessageIds,
        protectedMessageCount: selection.protectedMessageCount,
        sourceTokenEstimate: selection.sourceTokenEstimate,
        summaryBudget,
        beforeBudget: beforeEstimate.budget,
        beforeTokens: beforeEstimate.tokens
      })
    }

    // BL-224: the summarizer reads who said what the way the agent does. A group chat's summary
    // is spliced into every member's history, so it is for no one agent and names every agent.
    const speakers = await resolveCompiledSpeakerView({
      messages: selection.sourceMessages,
      selfAgentId: session.metadata?.group_chat ? null : agentId
    })
    const transcript = buildCompactionTranscript(selection.sourceMessages, speakers)
    const liveProtectedNote = buildLiveProtectedItemsNote({
      protectedMessageIds: selection.protectedMessageIds,
      protectedUnzippedZipIds: protections.protectedUnzippedZipIds,
      activeClipIds: protections.activeClipIds
    })
    const prompt = buildCompactPrompt({
      settings: effectiveSettings,
      transcript,
      liveProtectedNote,
      summarySoftTargetTokens: summaryBudget.softTargetTokens,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens
    })

    // A Stop during setup (the reads above, the token estimate, the speaker view) already aborted
    // this run's signal by the time we get here: answer as a stopped Compact does, with no model
    // call and nothing written.
    if (compactRun.signal.aborted) return stoppedAnswer()
    let compactResult: Awaited<ReturnType<typeof generateModelSummary>>
    try {
      compactResult = await generateModelSummary({
        userId: user.value.id,
        agent,
        choice: {
          modelMode: effectiveSettings.modelMode,
          modelPresetId: effectiveSettings.modelPresetId
        },
        prompt,
        summaryHardMaxTokens: summaryBudget.hardMaxTokens,
        abortSignal: compactRun.signal,
        retainPlanLease: lease => { planLease = lease }
      })
    } catch (error) {
      if (compactRun.signal.aborted) return stoppedAnswer()
      throw error
    }

    const now = new Date().toISOString()
    if (planLease) getChatgptPlanRuntime().assertLease(planLease)
    const event: ContextCompactionEvent = {
      id: crypto.randomUUID(),
      createdAt: now,
      mode,
      agentId,
      compactedThroughMessageId: selection.compactedThroughMessageId,
      sourceMessageIds: selection.sourceMessageIds,
      protectedMessageIds: selection.protectedMessageIds,
      compactedMessageCount: selection.compactedMessageCount,
      protectedMessageCount: selection.protectedMessageCount,
      sourceTokenEstimate: selection.sourceTokenEstimate,
      summaryTokenEstimate: countTotalTokens([{ role: 'system', content: compactResult.summary }]),
      summarySoftTargetTokens: summaryBudget.softTargetTokens,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens,
      modelMode: effectiveSettings.modelMode,
      modelPresetId: effectiveSettings.modelPresetId,
      modelLabel: compactResult.modelLabel,
      provider: compactResult.provider,
      modelId: compactResult.modelId,
      promptVersion: 1,
      summary: compactResult.summary
    }

    // BL-622 (C1, C2): the event is added at its own path, only while the chat's last event is the
    // one read above, before the summary call. Writing back the metadata read above erased what
    // another writer added during that call (a graduation mark, a group removal, a second
    // Compact's event).
    // A Stop that came after the model answered still stops the write.
    if (compactRun.signal.aborted) return stoppedAnswer()
    // BL-622 (C4): look again before the write. A message the user protected during the summary
    // call (an unzip in the Zip Manager, an active clip) must stay live, so it cannot be inside
    // this summary. The event list's look is C2's conditional append below.
    const protectionsNow = await loadContextProtections(sessionId)
    if (selection.sourceMessages.some((message) => isMessageProtectedFromManualTrim(message, protectionsNow))) {
      return endedEarlyAnswer('message_protected')
    }
    // New pending cards (including an in-place resume's replacement) are saved inside a
    // registered turn. Settlement cannot create one, and browser assistant saves are refused.
    // The final watermark below covers those turns even if they already ended; no second scan.
    if (compactRun.signal.aborted) return stoppedAnswer()
    // The turn look comes last, with no I/O between it and the write's dispatch (the append's
    // only await is the client handle, which runs no new I/O): the user's
    // message goes first, and a turn that started since this Compact started (running now or
    // already over) compiled a history this Compact did not see.
    if (isTurnRunning(sessionId) || hasTurnStartedAfter(sessionId, seenTurnId)) {
      return endedEarlyAnswer('turn_started')
    }
    if (planLease) getChatgptPlanRuntime().assertLease(planLease)
    const written = await redis.appendContextCompactionEvent(
      sessionId,
      event as unknown as Record<string, unknown>,
      compactionState.events.at(-1)?.id ?? null
    )
    if (!written.ok && written.reason === 'missing') {
      return json({ error: 'Session not found' }, { status: 404 })
    }
    if (!written.ok) {
      return json(
        {
          error: 'Another Compact finished in this chat first. This Compact wrote nothing.',
          code: 'ended_early',
          reason: 'compaction_changed'
        },
        { status: 409 }
      )
    }

    const afterEstimate = await estimateCurrentContextTokens({
      sessionId,
      messages,
      agent,
      userId: user.value.id,
      agentTypeHint: typeof body?.agentType === 'string' ? body.agentType : undefined,
      trimmedMessageIds: Array.isArray(body?.trimmedMessageIds) ? body.trimmedMessageIds : [],
      eventFetch
    })

    const compactedTrimmedMessageIds = normalizeStringArray(body?.trimmedMessageIds)
      .filter((id) => selection.sourceMessageIds.includes(id))

    return json({
      success: true,
      event,
      contextCompaction: written.contextCompaction,
      compactedMessageIds: selection.sourceMessageIds,
      compactedTrimmedMessageIds,
      protectedMessageCount: selection.protectedMessageCount,
      sourceTokenEstimate: selection.sourceTokenEstimate,
      summaryTokenEstimate: event.summaryTokenEstimate,
      summaryBudget,
      beforeBudget: beforeEstimate.budget,
      beforeTokens: beforeEstimate.tokens,
      afterBudget: afterEstimate.budget,
      afterTokens: afterEstimate.tokens,
      modelLabel: compactResult.modelLabel
    })
  } catch (error) {
    console.error('[context-compact] Failed to compact context:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to compact context' },
      { status: chatgptPlanHttpStatus(error) ?? 500 }
    )
  } finally {
    planLease?.release()
    compactRun?.end()
  }
}
