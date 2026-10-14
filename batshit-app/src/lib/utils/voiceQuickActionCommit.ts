import { approvalSummaryIsPending } from './heldForApproval'

export interface VoiceSteerIdentity {
  steerId: string
  sessionId: string
  targetMessageId?: string
}

/** A server event or server-read record, never browser send metadata. */
export interface VoiceReplyObservation {
  sessionId: string
  type: string
  messageId?: string
  steerId?: string
  role?: string
  status?: string
  metadata?: Record<string, any>
}

export interface VoiceQuickActionCommitContext {
  sessionId: string | null
  agentId: string | null
}

export interface VoiceQuickActionCommitToken {
  generation: number
  context: VoiceQuickActionCommitContext
  signal: AbortSignal
}

export interface VoiceQuickActionCommitCoordinator {
  begin(context: VoiceQuickActionCommitContext): VoiceQuickActionCommitToken
  isCurrent(token: VoiceQuickActionCommitToken, context: VoiceQuickActionCommitContext): boolean
  ownsLatestGeneration(token: VoiceQuickActionCommitToken): boolean
  finish(token: VoiceQuickActionCommitToken): boolean
  invalidate(): boolean
  invalidateContext(context: VoiceQuickActionCommitContext): boolean
}

export interface VoiceQuickActionCommitDecision<Mark> {
  mark: Mark | null
  onlyThis: boolean
}

export interface RunVoiceQuickActionCommitOptions<Verdict, Mark> {
  coordinator: VoiceQuickActionCommitCoordinator
  token: VoiceQuickActionCommitToken
  currentContext: () => VoiceQuickActionCommitContext
  requestVerdict: () => Promise<Verdict | null>
  decide: (verdict: Verdict | null) => VoiceQuickActionCommitDecision<Mark>
  applyAction: (verdict: Verdict, mark: Mark) => void
  persistOnly: (mark: Mark) => Promise<void>
  send: (mark: Mark | null, beforeSend: () => boolean) => Promise<boolean>
  releasePending: () => void
}

function sameContext(left: VoiceQuickActionCommitContext, right: VoiceQuickActionCommitContext) {
  return left.sessionId === right.sessionId && left.agentId === right.agentId
}

export function voiceQuickActionSnapshotMatches(
  capturedContext: VoiceQuickActionCommitContext,
  currentContext: VoiceQuickActionCommitContext,
  capturedText: string,
  currentText: string
) {
  return sameContext(capturedContext, currentContext) && capturedText === currentText
}

/**
 * Owns the browser-side interval between a Voice Mode transcript becoming final and Batshit
 * committing that turn. Jev can make that interval last for the user's full In-Chat Wait Limit,
 * so a result belongs only to the chat and agent that began it.
 */
export function createVoiceQuickActionCommitCoordinator(): VoiceQuickActionCommitCoordinator {
  let generation = 0
  let active: { token: VoiceQuickActionCommitToken; controller: AbortController } | null = null
  let latestToken: VoiceQuickActionCommitToken | null = null

  const invalidate = () => {
    // beforeSend retires the verdict token while its accepted send still owns Voice's
    // wait. End must release that wait too; a second End owns nothing newer.
    const ownedWait = latestToken?.generation === generation
    generation += 1
    active?.controller.abort()
    active = null
    return ownedWait
  }

  return {
    begin(context) {
      active?.controller.abort()
      const controller = new AbortController()
      const token: VoiceQuickActionCommitToken = {
        generation: ++generation,
        context: { ...context },
        signal: controller.signal
      }
      latestToken = token
      active = { token, controller }
      return token
    },
    isCurrent(token, context) {
      return active?.token === token && !token.signal.aborted && sameContext(token.context, context)
    },
    ownsLatestGeneration(token) {
      return generation === token.generation && !token.signal.aborted
    },
    finish(token) {
      if (active?.token !== token) return false
      active = null
      return true
    },
    invalidate,
    invalidateContext(context) {
      if (
        !latestToken ||
        latestToken.generation !== generation ||
        !sameContext(latestToken.context, context)
      ) return false
      if (active) return invalidate()
      // The token can be retired just before a delayed accepted/persist callback. A context
      // cleanup still has to retire that callback's reset authority even though no verdict is active.
      generation += 1
      return true
    }
  }
}

/**
 * Commits one delayed Voice Mode turn while keeping every effect behind the captured context.
 * `send` returns whether the page accepted the turn; a refusal or exception releases Voice Mode's
 * waiting state even when `beforeSend` already retired the coordinator token.
 */
export async function runVoiceQuickActionCommit<Verdict, Mark>(
  options: RunVoiceQuickActionCommitOptions<Verdict, Mark>
): Promise<'stale' | 'only-this' | 'sent' | 'refused'> {
  let released = false
  const releasePending = () => {
    if (released) return
    if (!options.coordinator.ownsLatestGeneration(options.token)) return
    released = true
    options.releasePending()
  }

  try {
    const verdict = await options.requestVerdict()
    if (!options.coordinator.isCurrent(options.token, options.currentContext())) {
      return 'stale'
    }

    const decision = options.decide(verdict)
    if (verdict !== null && decision.mark !== null) {
      options.applyAction(verdict, decision.mark)
      if (decision.onlyThis) {
        options.coordinator.finish(options.token)
        releasePending()
        await options.persistOnly(decision.mark)
        return 'only-this'
      }
    }

    const accepted = await options.send(decision.mark, () => {
      if (!options.coordinator.isCurrent(options.token, options.currentContext())) return false
      options.coordinator.finish(options.token)
      return true
    })
    if (!accepted) releasePending()
    return accepted ? 'sent' : 'refused'
  } catch (error) {
    releasePending()
    throw error
  } finally {
    if (options.coordinator.finish(options.token)) releasePending()
  }
}

/** Complete only the captured spoken send; Voice End/restart retires even a same-chat token. */
export function createVoiceNoReplyCompletion(options: {
  coordinator: VoiceQuickActionCommitCoordinator
  token: VoiceQuickActionCommitToken
  currentContext: () => VoiceQuickActionCommitContext
  releaseWaiting: () => void
}): () => void {
  return () => {
    // beforeSend retires the active verdict token. Its generation still owns the send
    // until Voice End/context change or a newer commit invalidates that authority.
    if (options.coordinator.ownsLatestGeneration(options.token) &&
      sameContext(options.token.context, options.currentContext())) options.releaseWaiting()
  }
}

/** Generic reply completion cannot retire a spoken preparation or its queued send (BL-1291/1295). */
export function createVoiceQueuedReplyWait(options: {
  coordinator: VoiceQuickActionCommitCoordinator
  token: VoiceQuickActionCommitToken
  currentContext: () => VoiceQuickActionCommitContext
  releaseWaiting: () => void
}) {
  let preparing = true
  let queued = false
  let inbox: { identity: VoiceSteerIdentity; receivingId: string | null; settled: boolean;
    pausedVersion: number | null; latestVersion: number; receivingOwnsWords: boolean } | null = null
  const retiredReceivingIds = new Set<string>()
  const ownsWait = () => options.coordinator.ownsLatestGeneration(options.token) &&
    sameContext(options.token.context, options.currentContext())

  return {
    holdGenericReplyCompletion() {
      return ownsWait() && (preparing || queued || Boolean(inbox && !inbox.settled))
    },
    onSteerPrepared(identity: VoiceSteerIdentity) {
      if (!ownsWait() || identity.sessionId !== options.token.context.sessionId) return
      // Installed BEFORE POST: delivery, promotion and its terminal can race the 202.
      retiredReceivingIds.clear()
      inbox = { identity: { ...identity }, receivingId: null, settled: false, pausedVersion: null, latestVersion: 0, receivingOwnsWords: false }
    },
    onTargetStopped(sessionId: string, messageId: string) {
      if (!ownsWait() || !inbox || inbox.settled || sessionId !== inbox.identity.sessionId) return
      // A local, confirmed Stop owns only this exact receiving reply (or the target
      // before delivery). It is also the fallback when the transient disposition was lost.
      if (messageId !== (inbox.receivingId ?? inbox.identity.targetMessageId)) return
      inbox.settled = true
      options.releaseWaiting()
    },
    observeReply(observation: VoiceReplyObservation) {
      if (!ownsWait() || !inbox || inbox.settled || observation.sessionId !== inbox.identity.sessionId) return
      const metadata = observation.metadata ?? {}
      const relation = metadata.steerPromoted
      const matchesPromotion = Array.isArray(relation?.steerIds) && relation.steerIds.includes(inbox.identity.steerId)
      const matchesDelivered = Array.isArray(metadata.steers) && metadata.steers.some(
        (steer: any) => steer?.steerId === inbox!.identity.steerId && steer.source !== 'dm'
      )
      const release = () => {
        inbox!.settled = true
        options.releaseWaiting()
      }
      const bindReceiving = (messageId: string, ownsWords: boolean) => {
        if (retiredReceivingIds.has(messageId)) return false
        if (messageId !== inbox!.receivingId) {
          const previous = inbox!.receivingId ?? inbox!.identity.targetMessageId
          if (previous && previous !== messageId) retiredReceivingIds.add(previous)
          inbox!.receivingId = messageId
          inbox!.pausedVersion = null
          inbox!.latestVersion = 0
          inbox!.receivingOwnsWords = false
        }
        if (ownsWords) inbox!.receivingOwnsWords = true
        return true
      }
      // Once an exact successor owns the answer, an older card's replay cannot
      // reclaim it. In-place resumes retain the same id and use the version fence.
      if (observation.messageId && retiredReceivingIds.has(observation.messageId)) return
      if (matchesPromotion && (relation.disposition === 'unanswered' || metadata.approvalCardExpired === true)) {
        release()
        return
      }
      if (observation.type === 'steer_delivered' && observation.steerId === inbox.identity.steerId && observation.messageId) {
        bindReceiving(observation.messageId, true)
        return
      }
      if (matchesPromotion && relation.disposition === 'awaiting_approval' && metadata.waitsForApproval?.messageId) {
        if (bindReceiving(metadata.waitsForApproval.messageId, false)) {
          const pausedVersion = Number.isSafeInteger(relation.approvalResumeVersion) ? relation.approvalResumeVersion : inbox.latestVersion
          if (pausedVersion >= inbox.latestVersion) {
            inbox.pausedVersion = pausedVersion
            inbox.latestVersion = pausedVersion
          }
        }
      }
      // A promoted USER record (including an approval hold) is not an answer.
      if (observation.role === 'user' || observation.type === 'user_message' || observation.type === 'steer_promoted') return
      if (observation.messageId && (matchesPromotion || matchesDelivered)) {
        bindReceiving(observation.messageId, true)
      }
      if (!observation.messageId || observation.messageId !== inbox.receivingId) return
      // waitsForApproval names the card, not a run that compiled these words. Its API
      // in-place resume can finish before the held answer even starts. Only an actual
      // delivered/promoted run, or the exact no-answer disposition above, owns completion.
      if (!inbox.receivingOwnsWords) return
      const version = Number.isSafeInteger(metadata.approvalResumeVersion) ? metadata.approvalResumeVersion :
        Number.isSafeInteger(metadata.approvalResume?.version) ? metadata.approvalResume.version :
        matchesPromotion && relation.disposition === 'awaiting_approval' && Number.isSafeInteger(relation.approvalResumeVersion)
          ? relation.approvalResumeVersion : 0
      if (version < inbox.latestVersion) return
      inbox.latestVersion = version
      if (matchesPromotion && relation.disposition === 'awaiting_approval' && Number.isSafeInteger(relation.approvalResumeVersion)) {
        inbox.pausedVersion = relation.approvalResumeVersion
      }
      const failed = observation.type === 'error' || observation.status === 'error' ||
        metadata.interrupted === true || metadata.response_failed === true
      if (!failed && approvalSummaryIsPending(metadata.toolApprovals)) {
        inbox.pausedVersion = version
        return
      }
      if (!failed && version === 0 && Array.isArray(metadata.answeredApprovalIds) && metadata.answeredApprovalIds.length) {
        inbox.pausedVersion ??= 0
      }
      const terminal = ['end', 'complete', 'error'].includes(observation.type) ||
        (['record', 'complete_message'].includes(observation.type) && ['complete', 'error'].includes(observation.status ?? ''))
      if (!terminal) return
      // Answering a card clears its approvals BEFORE the resume starts. Neither that
      // reload nor the pause's trailing complete is the answer. A newer resume version,
      // or an exact terminal failure/disposition, must finish this receiving reply.
      if (!failed && inbox.pausedVersion !== null && version <= inbox.pausedVersion) return
      release()
    },
    onReplyAdmitted(kind: 'direct' | 'steer' | 'queued') {
      if (!ownsWait() || !preparing) return
      queued = kind === 'queued'
      if (kind !== 'steer') inbox = null
      preparing = false
    },
    finishSend() {
      if (!ownsWait()) return
      // A queued send's onSend promise waits for its OWN final turn outcome, not its
      // early 202. A direct send keeps its own stream completion; an unrelated end
      // held during preparation does not complete it. An inbox receipt is NOT a reply;
      // exact delivery/promotion/terminal observations own that separate wait.
      const release = queued
      queued = preparing = false
      if (release) options.releaseWaiting()
    },
    abandonSend() {
      queued = preparing = false
      inbox = null
      // runVoiceQuickActionCommit's existing generation-owned refusal/error path releases.
    }
  }
}
