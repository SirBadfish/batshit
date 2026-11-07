import { redis } from '$lib/server/redis'
import { SkillSessionCommitError, type SkillSessionRawGuard } from './skillSessionCommit'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { resolveAgentJevSkillSessionsEnabled } from '$lib/utils/jevJuiceControl'
import { judgeNameOfCallRecord } from '$lib/utils/judgeProviders'
import type { SkillSessionEntry } from '$lib/utils/skillSessions'
import type { TypesafeCallRecord } from '$lib/types/typesafe'
import { normalizeCompactTool, resolveApiUtilityPresentation, toolOutputCut } from '$lib/utils/toolActivityContract'
import { unwrapSubagentToolResult } from '$lib/utils/toolPayloadUnwrap'
import { readWaitsForApproval } from '$lib/utils/heldForApproval'
import { filterQueuedSendMessageIds } from './queuedSendHiddenIds'
import { createHash } from 'node:crypto'
import { lastTurnStartOf, hasTurnStartedAfter } from './streamAbortRegistry'
import { REPLY_SAVED_FROM_OWN_COPY_KEY } from './replyStreamRecord'
import type { JevJuiceHintProvider } from './typesafe/jevJuiceHintContext'
import { appendTypesafeCallRecords } from './typesafe/typesafeEvidence'
import { computeSkillSessionCloses, type SkillSessionCloseCandidate, type SkillSessionCloseEvidence } from './skillSessions.jev'
import { captureSkillSessionSnapshot, closeSkillSession, readSkillSessionNotices, markSkillSessionNoticesTold, SkillSessionSourceChanged, type SkillSessionActor } from './skillSessions'
import { savedReplyTask, replyProseForJudgment, joinReplyParts, type EarlierReplyPart, type PostTurnHistoryMessage } from './typesafe/jevJuiceTurn'

/** Conservative factual guard: a failed/partial/deferred tool keeps skills open without judging. */
export function skillTurnHasUnfinishedTools(steps: readonly unknown[]): boolean {
  return steps.some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true
    const step = value as Record<string, any>
    const raw = step.toolResult ?? step.result
    if (step.error || !raw) return true
    const input = { ...step, toolArgs: step.toolArgs ?? step.toolInput ?? {}, toolResult: raw }
    const utility = resolveApiUtilityPresentation(input as any)
    const compact = normalizeCompactTool(input as any)
    const kind = compact.operationKind
    const name = String(step.originalToolName || step.toolName || '')
    if (!name) return true
    // SA-139 P7: the CLI Subagent bridge's tool names (`mcp__batshit_gateway_<segment>__subagent_<key>`
    // and `…__spawn_workers`) went with the CLI lanes (R4, R5); nothing produces them, and an
    // unknown name stays "not finished" below.
    const delegated = utility?.kind === 'workers' || utility?.kind === 'subagent' || name === 'native_spawn_workers' ||
      step.toolProvider === 'subagent'
    if (kind === 'workers' || kind === 'subagent') {
      if (!delegated) return true // Unknown delegation-shaped text cannot certify completion.
      let facts: any = utility?.raw ?? unwrapSubagentToolResult(raw)
      for (let depth = 0; depth < 7 && facts && typeof facts === 'object'; depth += 1) {
        if (facts.kind === 'workers' || Array.isArray(facts.workers)) {
          return facts.success !== true || !Array.isArray(facts.workers) || !Number.isSafeInteger(facts.requested) ||
            facts.workers.length !== facts.requested || facts.completed !== facts.requested ||
            facts.workers.some((worker: any) => worker?.status !== 'completed')
        }
        if (typeof facts.status === 'string') return facts.status !== 'completed'
        facts = facts.output ?? facts.result ?? facts.data
      }
      return true
    }
    // Never parse Bash stdout or arbitrary prose as a worker status. Ordinary structured
    // execution flags remain facts; unaccounted cut results remain uncertain.
    const facts = utility?.raw ?? compact.toolResult as any
    return raw.success === false || facts?.success === false || raw.blocked === true || facts?.blocked === true || !!raw.error || !!facts?.error || raw.isError === true ||
      raw.modelTextOnly === true || facts?.modelTextOnly === true || !!toolOutputCut(raw) || !!toolOutputCut(facts) || raw.awaitingApproval === true ||
      ['partial', 'failed', 'timed_out', 'stopped', 'cancelled', 'running', 'pending'].includes(raw.status)
  })
}

/** Read only the original-task chains actually needed, strictly and without tolerant history. */
async function loadOriginalTasks(actor: SkillSessionActor, messageIds: string[]) {
    const allIds = await redis.lRange(`messages:${actor.sessionId}`, 0, -1)
    const guards: SkillSessionRawGuard[] = [{ kind: 'list', key: `messages:${actor.sessionId}`, values: allIds }]
    const ids = filterQueuedSendMessageIds(actor.sessionId, allIds)
    const loaded = new Map<string, PostTurnHistoryMessage>()
    const tasks = new Map<string, ReturnType<typeof savedReplyTask>>()
    const latestUsers = new Map<string, string | null>()
    for (const messageId of new Set(messageIds)) {
      const index = ids.indexOf(messageId)
      if (index < 0) { tasks.set(messageId, null); continue }
      const reverse: PostTurnHistoryMessage[] = []
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const id = ids[cursor]
        let message = loaded.get(id)
        if (!message) {
          const raw = await guardedMessage(actor, id, guards)
          if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id !== id || raw.session_id !== actor.sessionId ||
              raw.user_id !== actor.userId || !['assistant', 'user', 'system'].includes(raw.role) || typeof raw.content !== 'string' ||
              raw.metadata !== undefined && raw.metadata !== null && (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata))) {
            throw new Error('An original skill task message is unavailable or inconsistent.')
          }
          message = raw as PostTurnHistoryMessage
          loaded.set(id, message)
        }
        if (message.role === 'assistant' && message.metadata?.[REPLY_SAVED_FROM_OWN_COPY_KEY] === true) {
          throw new Error('The whole saved reply has an unverified stream gap.')
        }
        reverse.push(message)
        if (message.role === 'user' && !latestUsers.has(messageId)) latestUsers.set(messageId, id)
        if (message.role === 'user' && !message.metadata?.approvalResume && !readWaitsForApproval(message.metadata)) {
          tasks.set(messageId, savedReplyTask([...reverse].reverse(), messageId))
          break
        }
      }
      if (!tasks.has(messageId)) tasks.set(messageId, null)
    }
    return { tasks, latestUsers, guards }
}

const taskFingerprint = (source: Awaited<ReturnType<typeof loadOriginalTasks>>) =>
  createHash('sha256').update(JSON.stringify([[...source.tasks], [...source.latestUsers]])).digest('hex')

async function guardedMessage(actor: SkillSessionActor, id: string, guards: SkillSessionRawGuard[]): Promise<any> {
  const key = `message:${actor.sessionId}:${id}`
  const raw = await redis.json.getRaw(key, '$')
  guards.push({ kind: 'json', key, raw })
  if (raw === null) return null
  const values = JSON.parse(raw)
  if (!Array.isArray(values) || values.length !== 1) throw new Error('A saved skill task root is unavailable.')
  return values[0]
}

async function latestSavedUserId(actor: SkillSessionActor, guards: SkillSessionRawGuard[] = []): Promise<string | null> {
  const ids = await redis.lRange(`messages:${actor.sessionId}`, 0, -1)
  guards.push({ kind: 'list', key: `messages:${actor.sessionId}`, values: ids })
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const raw = await guardedMessage(actor, ids[index], guards)
    if (!raw || raw.id !== ids[index] || raw.session_id !== actor.sessionId || raw.user_id !== actor.userId) {
      throw new Error('The latest saved user intent could not be verified.')
    }
    if (raw.role === 'user') return raw.id
  }
  return null
}

export function buildSkillSessionTurn(input: SkillSessionActor & { isGroupTurn: boolean }) {
  const turnEpoch = lastTurnStartOf(input.sessionId)
  let told: Array<Pick<SkillSessionEntry, 'skillId' | 'revision'>> = []
  const hintProvider: JevJuiceHintProvider = async () => {
    if (input.isGroupTurn) return []
    const notices = await readSkillSessionNotices(input)
    told = notices.map(({ skillId, revision }) => ({ skillId, revision }))
    return notices.length ? ['skill_sessions_closed (inferred):', ...notices.map((entry) =>
      `- ${entry.skillId}: ${entry.closedByJudgeName || 'the judge'} closed this skill after its task appeared complete. Read it again if you still need it.`)] : []
  }

  return {
    hintProvider,
    markTold: () => told.length ? markSkillSessionNoticesTold(input, told) : Promise.resolve(),
    async runPostTurn(post: {
      messageId: string; request: string; reply: string; recentUserIntent: string[];
      earlierParts: EarlierReplyPart[]; toolSteps: unknown[]; origin: SkillSessionCloseEvidence['origin']; signal?: AbortSignal
      lineageComplete: boolean
    }): Promise<void> {
      const append = async (record: TypesafeCallRecord) => {
        try {
          if (await appendTypesafeCallRecords(input.sessionId, post.messageId, [record])) return
        } catch { /* Same visible missed-attachment path as an absent snapshot. */ }
          console.warn('[Skill sessions] After-reply evidence could not attach to its snapshot:', { sessionId: input.sessionId, messageId: post.messageId })
      }
      let judgmentStarted = false
      const skip = async (reason: string) => append({ feature: 'skill_tool_hints', model: null, status: 'error', reason: 'local_error',
        latencyMs: 0, usage: null, deadlineHit: false, questionCount: 0, at: new Date().toISOString(),
        decision: 'Skill close check did not finish; inspect current open_skills.',
        detail: `${judgmentStarted ? 'A judgment may have been requested; no whole check was confirmed' : 'No judge request was sent'}: ${reason}` })
      try {
        if (input.isGroupTurn || post.origin === 'wake') return
        const agent = await redis.json.get(`agent:${input.agentId}`) as Record<string, any> | null
        if (!agent || !resolveAgentJevSkillSessionsEnabled(agent)) return
        const snapshots = await captureSkillSessionSnapshot(input)
        if (snapshots.length === 0) return
        if (!post.lineageComplete) { await skip('the whole reply lineage is unavailable'); return }
        const sourceIds = [...snapshots.map((snapshot) => snapshot.openedMessageId), post.messageId]
        const source = await loadOriginalTasks(input, sourceIds)
        const current = source.tasks.get(post.messageId)
        const whole = current ? replyProseForJudgment(joinReplyParts(current.earlierParts, '')) : ''
        if (!current || current.request !== post.request || whole !== replyProseForJudgment(joinReplyParts(post.earlierParts, post.reply))) {
          await skip('the saved whole reply and its original request do not match the verified turn')
          return
        }
        const latestGuards: SkillSessionRawGuard[] = []
        const latestUserId = await latestSavedUserId(input, latestGuards)
        if (latestUserId !== source.latestUsers.get(post.messageId) || hasTurnStartedAfter(input.sessionId, turnEpoch)) {
          await skip('a newer user intent or turn has arrived')
          return
        }
        const sourceFingerprint = taskFingerprint(source)
        const candidates: SkillSessionCloseCandidate[] = []
        for (const snapshot of snapshots) {
          const original = source.tasks.get(snapshot.openedMessageId)
          const holds = await Promise.all(snapshot.reads.map((read) => redis.json.get(`unzipped_item:${input.sessionId}:${read.zipId}`) as Promise<any>))
          // Source/task omission never becomes permission to close. Windows remain separate;
          // their source hashes/ranges report exactly the reads made, including mixed versions.
          const complete = snapshot.reads.length > 0 && snapshot.reads.every((read) =>
            typeof read.sourceSha256 === 'string' && typeof read.returnedChars === 'number' && typeof read.originalChars === 'number')
          candidates.push({ ...snapshot, description: snapshot.name,
            taskRequest: original?.request || '',
            readWindows: snapshot.reads.map((read) => `${read.path} | source ${read.sourceSha256 || 'unknown'} | offset ${read.offset ?? 0}, returned ${read.returnedChars ?? 'unknown'} of ${read.originalChars ?? 'unknown'} characters`),
            readWindowsComplete: complete,
            automatic: holds.filter((_hold, index) => snapshot.reads[index].required !== false)
              .every((hold) => hold?.source === 'agent' && hold?.agentId === input.agentId && hold?.skillSession?.automatic === true),
            hasExplicitHold: holds.some((hold, index) => !hold ? snapshot.reads[index].required !== false :
              hold.source !== 'agent' || hold.agentId !== input.agentId || hold.skillSession?.automatic !== true)
          })
        }
        judgmentStarted = true
        const outcome = await computeSkillSessionCloses({
          userId: input.userId, agent, candidates, signal: post.signal,
          evidence: {
            request: current.request, reply: whole,
            recentUserIntent: post.recentUserIntent, complete: !!post.request.trim(), finished: true,
            unfinishedWork: skillTurnHasUnfinishedTools([...current.earlierParts.flatMap((part) => part.toolSteps), ...post.toolSteps]),
            scope: 'primary', origin: post.origin
          }
        })
        if (!outcome.record) return
        const applied: string[] = []
        const statuses: string[] = []
        for (const proposed of outcome.decision?.close ?? []) {
          try {
            const closed = await closeSkillSession({ ...input, skillId: proposed.candidate.skillId,
              provenance: 'inferred', expected: proposed.candidate, judgeName: judgeNameOfCallRecord(outcome.record),
              taskGuards: [...source.guards, ...latestGuards],
              beforeIssue: () => {
                if (hasTurnStartedAfter(input.sessionId, turnEpoch)) throw new SkillSessionSourceChanged('A newer turn has begun; the old skill judgment cannot close it.')
              },
              revalidateTask: async () => !hasTurnStartedAfter(input.sessionId, turnEpoch) &&
                await latestSavedUserId(input) === latestUserId &&
                taskFingerprint(await loadOriginalTasks(input, sourceIds)) === sourceFingerprint })
            statuses.push(`${proposed.candidate.skillId}: ${closed.status}${closed.reason ? ` (${closed.reason})` : ''}`)
            if (closed.status === 'closed') applied.push(...closed.changedZipIds)
          } catch (error) {
            if (error instanceof SkillSessionCommitError) statuses.push(`${proposed.candidate.skillId}: close outcome unconfirmed; no automatic retry`)
            else {
              // This owner performs no state write before its single guarded commit. Only
              // the commit owner's typed issued/partial errors represent uncertain writes.
              statuses.push(`${proposed.candidate.skillId}: refused before the write; no skill state was changed`)
              console.warn('[Skill sessions] A close was refused before its write:', error)
            }
          }
        }
        outcome.record.detail = [outcome.record.detail, ...statuses, ...outcome.skipped].filter(Boolean).join('; ')
        await append(outcome.record)
        if (applied.length) {
          try { await publishUserEvent(input.userId, { type: 'zip_state_changed', sessionId: input.sessionId,
            source: 'inferred', opened: [], rezipped: applied }) }
          catch { console.warn('[Skill sessions] Skill closure was stored, but its live refresh could not be published.') }
        }
      } catch (error) {
        await skip('original task, read-window or lifecycle facts could not be verified')
        console.error('[Skill sessions] After-reply management could not finish; skills remain as currently stored:', error)
      }
    }
  }
}
