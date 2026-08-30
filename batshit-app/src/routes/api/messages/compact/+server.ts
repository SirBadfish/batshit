import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import type { AgentRow } from '$lib/types/database'
import { isFixedSession } from '$lib/utils/fixedSession'
import {
  buildCompactionTranscript,
  buildLiveProtectedItemsNote,
  getContextCompactionState,
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

type AgentRecord = AgentRow & Record<string, any>

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

export const POST: RequestHandler = async ({ request, locals, fetch: eventFetch }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

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

    const compactionState = getContextCompactionState(session.metadata ?? null)
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

    const transcript = buildCompactionTranscript(selection.sourceMessages)
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

    const compactResult = await generateModelSummary({
      userId: user.value.id,
      agent,
      choice: {
        modelMode: effectiveSettings.modelMode,
        modelPresetId: effectiveSettings.modelPresetId
      },
      prompt,
      summaryHardMaxTokens: summaryBudget.hardMaxTokens
    })

    const now = new Date().toISOString()
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

    const nextMetadata = {
      ...(session.metadata ?? {}),
      contextCompaction: {
        version: 1,
        events: [...compactionState.events, event]
      }
    }
    await redis.updateSession(sessionId, { metadata: nextMetadata })

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
      contextCompaction: nextMetadata.contextCompaction,
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
      { status: 500 }
    )
  }
}
